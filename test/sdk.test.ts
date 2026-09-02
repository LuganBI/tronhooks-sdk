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
      return json({ id: 'w1', secret: 'whsec_1' });
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
