import type {
  AssetFilter,
  CreatedWebhookWatch,
  CreatedTelegramWatch,
  Direction,
  EventListItem,
  EventPage,
  Watch,
} from './types.js';

export class TronHooksError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryAfter: string | undefined = undefined,
  ) {
    super(message);
  }
}

export interface TronHooksOptions {
  /** default https://tronhooks.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout; writes are never automatically retried. Default 10 seconds. */
  timeoutMs?: number;
}

interface WatchParams { address: string; assetFilter: AssetFilter; direction?: Direction }
export type CreateWebhookParams = WatchParams & { webhookUrl: string; telegram?: false };
export type CreateTelegramParams = WatchParams & { telegram: true; webhookUrl?: never };
export type CreateWatchParams = CreateWebhookParams | CreateTelegramParams;

export interface ListEventsParams {
  limit?: number;
  /** Legacy exclusive ISO date bound; prefer cursor for stable pagination. */
  before?: string | Date;
  /** Opaque next_cursor token, passed unchanged. Mutually exclusive with before. */
  cursor?: string;
  since?: string | Date;
  watchId?: string;
}

const iso = (v: string | Date | undefined) =>
  v === undefined ? undefined : v instanceof Date ? v.toISOString() : v;

/**
 * tronhooks.com API client.
 *
 *   const th = new TronHooks('tw_live_…');
 *   const watch = await th.watches.create({ address: 'T…', assetFilter: 'ALL', webhookUrl: 'https://your.app/hook' });
 *   // store watch.secret — then verify incoming webhooks with constructEvent()
 *
 * Key prefixes are network-bound; the hosted service is mainnet-only (tw_live_).
 */
export class TronHooks {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    opts: TronHooksOptions = {},
  ) {
    if (!/^tw_(test|live)_[0-9a-f]{40}$/.test(apiKey)) {
      throw new Error('apiKey must look like tw_test_… or tw_live_…');
    }
    this.baseUrl = (opts.baseUrl ?? 'https://tronhooks.com').replace(/\/$/, '');
    const url = new URL(this.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('baseUrl must be an HTTP(S) URL without credentials, query or fragment');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return undefined as T;
    let json: Record<string, unknown>;
    try {
      const parsed: unknown = await res.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid response');
      json = parsed as Record<string, unknown>;
    } catch {
      if (res.ok) throw new Error('Invalid JSON response; a write outcome may be uncertain. Reconcile before retrying.');
      json = {};
    }
    if (!res.ok) {
      throw new TronHooksError(
        res.status,
        typeof json.code === 'string' ? json.code : undefined,
        typeof json.error === 'string' ? json.error : `HTTP ${res.status}`,
        res.headers.get('retry-after') ?? undefined,
      );
    }
    return json as T;
  }

  readonly watches = {
    /** Register once. Telegram requires personal binding in the console. */
    create: async <P extends CreateWatchParams>(params: P): Promise<P extends CreateTelegramParams ? CreatedTelegramWatch : CreatedWebhookWatch> => {
      const webhook = typeof params.webhookUrl === 'string' && params.webhookUrl.length > 0;
      if (webhook === (params.telegram === true)) throw new Error('Specify exactly one target: webhookUrl or telegram: true');
      const result = await this.request<P extends CreateTelegramParams ? CreatedTelegramWatch : CreatedWebhookWatch>('POST', '/v1/watches', {
        address: params.address,
        asset_filter: params.assetFilter,
        ...(params.direction ? { direction: params.direction } : {}),
        ...(webhook ? { webhook_url: params.webhookUrl } : { telegram: true }),
      });
      if (!result || typeof result.id !== 'string' || !result.id || result.channel !== (webhook ? 'webhook' : 'telegram') || (webhook ? typeof result.secret !== 'string' || !result.secret : result.secret !== undefined)) {
        throw new Error('Invalid create response; a write outcome may be uncertain. Reconcile before retrying.');
      }
      return result;
    },

    list: async (): Promise<Watch[]> =>
      (await this.request<{ data: Watch[] }>('GET', '/v1/watches')).data,

    delete: (id: string): Promise<void> =>
      this.request('DELETE', `/v1/watches/${encodeURIComponent(id)}`),
  };

  readonly events = {
    /** One page of past events (reconciliation safety net). */
    list: (params: ListEventsParams = {}): Promise<EventPage> => {
      const q = new URLSearchParams();
      if (params.cursor !== undefined && params.before !== undefined) throw new Error('Specify cursor or before, not both');
      if (params.cursor) q.set('cursor', params.cursor);
      if (params.limit !== undefined) q.set('limit', String(params.limit));
      const before = iso(params.before);
      if (before) q.set('before', before);
      const since = iso(params.since);
      if (since) q.set('since', since);
      if (params.watchId) q.set('watch_id', params.watchId);
      const qs = q.toString();
      return this.request('GET', `/v1/events${qs ? `?${qs}` : ''}`);
    },

    /** Iterate all events, newest first, paging automatically. */
    iterate: (params: Omit<ListEventsParams, 'before' | 'cursor'> = {}): AsyncGenerator<EventListItem> =>
      this.iterateEvents(params),
  };

  private async *iterateEvents(
    params: Omit<ListEventsParams, 'before' | 'cursor'>,
  ): AsyncGenerator<EventListItem> {
    let pagination: Pick<ListEventsParams, 'before' | 'cursor'> = {};
    const cursors = new Set<string>();
    for (;;) {
      const page = await this.events.list({ ...params, ...pagination });
      const stable = page.next_cursor !== undefined;
      const next = stable ? page.next_cursor : page.next_before;
      if (next && cursors.has(next)) throw new Error('Event pagination cursor repeated; reconciliation stopped');
      if (next) cursors.add(next);
      for (const item of page.data) yield item;
      if (!next) return;
      pagination = stable ? { cursor: next } : { before: next };
    }
  }
}
