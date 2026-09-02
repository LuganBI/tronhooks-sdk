import type {
  AssetFilter,
  CreatedWatch,
  EventListItem,
  EventPage,
  Watch,
} from './types.js';

export class TronHooksError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface TronHooksOptions {
  /** default https://tronhooks.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface CreateWatchParams {
  address: string;
  assetFilter: AssetFilter;
  webhookUrl: string;
}

export interface ListEventsParams {
  limit?: number;
  before?: string | Date;
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

  constructor(
    private readonly apiKey: string,
    opts: TronHooksOptions = {},
  ) {
    if (!/^tw_(test|live)_[0-9a-f]{40}$/.test(apiKey)) {
      throw new Error('apiKey must look like tw_test_… or tw_live_…');
    }
    this.baseUrl = (opts.baseUrl ?? 'https://tronhooks.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new TronHooksError(
        res.status,
        typeof json.code === 'string' ? json.code : undefined,
        typeof json.error === 'string' ? json.error : `HTTP ${res.status}`,
      );
    }
    return json as T;
  }

  readonly watches = {
    /** Register an address. The returned `secret` is shown exactly once. */
    create: (params: CreateWatchParams): Promise<CreatedWatch> =>
      this.request('POST', '/v1/watches', {
        address: params.address,
        asset_filter: params.assetFilter,
        webhook_url: params.webhookUrl,
      }),

    list: async (): Promise<Watch[]> =>
      (await this.request<{ data: Watch[] }>('GET', '/v1/watches')).data,

    delete: (id: string): Promise<void> =>
      this.request('DELETE', `/v1/watches/${encodeURIComponent(id)}`),
  };

  readonly events = {
    /** One page of past events (reconciliation safety net). */
    list: (params: ListEventsParams = {}): Promise<EventPage> => {
      const q = new URLSearchParams();
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
    iterate: (params: Omit<ListEventsParams, 'before'> = {}): AsyncGenerator<EventListItem> =>
      this.iterateEvents(params),
  };

  private async *iterateEvents(
    params: Omit<ListEventsParams, 'before'>,
  ): AsyncGenerator<EventListItem> {
    let before: string | undefined;
    for (;;) {
      const page = await this.events.list({ ...params, ...(before ? { before } : {}) });
      for (const item of page.data) yield item;
      if (!page.next_before) return;
      before = page.next_before;
    }
  }
}
