import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  SignatureVerificationError,
  TronHooks,
  TronHooksError,
  constructEvent,
  verifySignature,
} from '../src/index.js';

const KEY = `tw_live_${'a'.repeat(40)}`;
const sign = (body: string, secret: string) =>
  createHmac('sha256', secret).update(body).digest('hex');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('verifySignature / constructEvent', () => {
  const secret = 'whsec_deadbeef';
  const payload = JSON.stringify({ event_id: 'evt_1', type: 'transfer.confirmed', amount: '1.99' });

  it('accepts a valid signature (string and Buffer bodies)', () => {
    const sig = sign(payload, secret);
    expect(verifySignature(payload, sig, secret)).toBe(true);
    expect(verifySignature(Buffer.from(payload), sig, secret)).toBe(true);
  });

  it('rejects wrong secret, tampered body, malformed/missing signature', () => {
    const sig = sign(payload, secret);
    expect(verifySignature(payload, sig, 'whsec_other')).toBe(false);
    expect(verifySignature(payload + ' ', sig, secret)).toBe(false);
    expect(verifySignature(payload, 'zz', secret)).toBe(false);
    expect(verifySignature(payload, undefined, secret)).toBe(false);
  });

  it('constructEvent parses on success and throws on mismatch', () => {
    const event = constructEvent(payload, sign(payload, secret), secret);
    expect(event.event_id).toBe('evt_1');
    expect(() => constructEvent(payload, sign(payload, 'x'), secret)).toThrow(
      SignatureVerificationError,
    );
  });
});

describe('TronHooks client', () => {
  it('rejects malformed api keys upfront', () => {
    expect(() => new TronHooks('sk_nope')).toThrow(/tw_test_/);
  });

  it('creates a watch with the right wire format and auth header', async () => {
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(url)).toBe('https://tronhooks.com/v1/watches');
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.parse(String(init?.body))).toEqual({
        address: 'Txyz',
        asset_filter: 'ALL',
        webhook_url: 'https://app.example/hook',
      });
      return json({ id: 'w1', channel: 'webhook', secret: 'whsec_1' });
    });
    const th = new TronHooks(KEY, { fetchImpl: fetchImpl as typeof fetch });
    const w = await th.watches.create({
      address: 'Txyz',
      assetFilter: 'ALL',
      webhookUrl: 'https://app.example/hook',
    });
    expect(w.secret).toBe('whsec_1');
  });

  it('surfaces API errors as TronHooksError with status + code', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: 'Watch quota reached…', code: 'quota_exceeded' }, 402),
    );
    const th = new TronHooks(KEY, { fetchImpl: fetchImpl as typeof fetch });
    const err = await th.watches
      .create({ address: 'T1', assetFilter: 'ALL', webhookUrl: 'https://x/h' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TronHooksError);
    expect((err as TronHooksError).status).toBe(402);
    expect((err as TronHooksError).code).toBe('quota_exceeded');
  });

  it('delete resolves on 204', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const th = new TronHooks(KEY, { fetchImpl: fetchImpl as typeof fetch });
    await expect(th.watches.delete('w1')).resolves.toBeUndefined();
  });

  it('events.iterate pages until next_before is null', async () => {
    const pages = [
      { data: [{ event_id: 'e3' }, { event_id: 'e2' }], next_before: '2026-08-07T00:00:00Z' },
      { data: [{ event_id: 'e1' }], next_before: null },
    ];
    const seenUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      seenUrls.push(String(url));
      return json(pages[seenUrls.length - 1]);
    });
    const th = new TronHooks(KEY, { fetchImpl: fetchImpl as typeof fetch });
    const ids: string[] = [];
    for await (const ev of th.events.iterate({ limit: 2 })) ids.push(ev.event_id);
    expect(ids).toEqual(['e3', 'e2', 'e1']);
    expect(seenUrls[1]).toContain('before=2026-08-07');
  });
});

describe('0.2 channel and reconciliation contract', () => {
  it('encodes Telegram and direction without a webhook URL or secret', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ address: 'Txyz', asset_filter: 'USDT', direction: 'outgoing', telegram: true });
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return json({ id: 'w-tg', channel: 'telegram', webhook_url: null });
    });
    const result = await new TronHooks(KEY, { fetchImpl: fetchImpl as typeof fetch }).watches.create({ address: 'Txyz', assetFilter: 'USDT', direction: 'outgoing', telegram: true });
    expect(result.channel).toBe('telegram');
    expect(result.secret).toBeUndefined();
  });
  it('rejects both or neither target before any HTTP request', async () => {
    const fetchImpl = vi.fn();
    const th = new TronHooks(KEY, { fetchImpl });
    for (const params of [{ address: 'T', assetFilter: 'USDT' }, { address: 'T', assetFilter: 'USDT', telegram: true, webhookUrl: 'https://x.test/' }]) {
      await expect(th.watches.create(params as never)).rejects.toThrow('exactly one target');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([402, 409, 429, 503])('reports %i without retrying a create', async status => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'not accepted' }), { status, headers: { 'retry-after': '60' } }));
    const th = new TronHooks(KEY, { fetchImpl });
    await expect(th.watches.create({ address: 'Txyz', assetFilter: 'TRX', telegram: true })).rejects.toMatchObject({ status, retryAfter: '60' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('preserves an uncertain network failure without retrying', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('network failed'); });
    await expect(new TronHooks(KEY, { fetchImpl }).watches.create({ address: 'Txyz', assetFilter: 'TRX', telegram: true })).rejects.toThrow('network failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('stops a cyclic pagination response', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [], next_before: '2026-10-01T00:00:00Z' }));
    const collect = async () => { for await (const _event of new TronHooks(KEY, { fetchImpl }).events.iterate()) { /* empty fixture */ } };
    await expect(collect()).rejects.toThrow('cursor repeated');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('rejects credential-bearing base URLs and invalid timeouts', () => {
    expect(() => new TronHooks(KEY, { baseUrl: 'https://user:secret@example.com' })).toThrow('baseUrl');
    expect(() => new TronHooks(KEY, { baseUrl: 'https://example.com?token=secret' })).toThrow('baseUrl');
    expect(() => new TronHooks(KEY, { timeoutMs: 0 })).toThrow('timeoutMs');
  });
});


describe('HTTP response protocol failures', () => {
  it.each(['', 'not json', '[]', 'null', '"ok"', '{}', '{"id":"w1"}'])('rejects malformed successful JSON: %s', async body => {
    const fetchImpl = vi.fn(async () => new Response(body, { status: 201 }));
    await expect(new TronHooks(KEY, { fetchImpl }).watches.create({ address: 'Txyz', assetFilter: 'USDT', telegram: true })).rejects.toThrow('outcome may be uncertain');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('additive stable pagination', () => {
  it('prefers next_cursor over legacy date-time next_before without parsing the opaque value', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async url => {
      urls.push(String(url));
      return json(urls.length === 1 ? { data: [{ event_id: 'tie-b' }], next_before: '2026-10-19T00:00:00.000Z', next_cursor: 'v1.opaque_value' } : { data: [{ event_id: 'tie-a' }], next_before: null, next_cursor: null });
    });
    const ids: string[] = [];
    for await (const event of new TronHooks(KEY, { fetchImpl }).events.iterate()) ids.push(event.event_id);
    expect(ids).toEqual(['tie-b', 'tie-a']);
    expect(urls[1]).toContain('cursor=v1.opaque_value'); expect(urls[1]).not.toContain('before=');
  });
});


it('an unexpected create 204 is an uncertain protocol failure, while delete 204 remains valid', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  const th = new TronHooks(KEY, { fetchImpl });
  await expect(th.watches.create({ address: 'Txyz', assetFilter: 'USDT', telegram: true })).rejects.toThrow('outcome may be uncertain');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(th.watches.delete('w1')).resolves.toBeUndefined();
});
