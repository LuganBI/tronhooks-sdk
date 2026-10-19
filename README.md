# @tronhooks/sdk

TRON deposit webhooks for developers — watch USDT/TRX addresses, get signed
webhooks on confirmed transfers, verify in one line. Client for
[tronhooks.com](https://tronhooks.com).

[![npm](https://img.shields.io/npm/v/@tronhooks/sdk)](https://www.npmjs.com/package/@tronhooks/sdk)
[![ci](https://github.com/LuganBI/tronhooks-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/LuganBI/tronhooks-sdk/actions)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

Docs: [AI guide](https://tronhooks.com/docs/ai/) · [Offline examples](https://tronhooks.com/docs/ai/examples/) · [Quickstart](https://tronhooks.com/docs/quickstart/) · [API reference](https://tronhooks.com/docs/api/) · [OpenAPI](https://tronhooks.com/docs/openapi.json) · [Verifying signatures](https://tronhooks.com/docs/webhooks/) · [Error codes](https://tronhooks.com/docs/errors/)

```bash
npm install https://tronhooks.com/docs/ai/packages/tronhooks-sdk-0.2.0.tgz
```

Verify the downloaded version against the [SHA-256 manifest](https://tronhooks.com/docs/ai/packages/manifest.json). The direct download provides 0.2.0 independently of npm registry publication. The registry version is a separate release check.

## Three lines to your first webhook

```ts
import { TronHooks, constructEvent } from '@tronhooks/sdk';

const th = new TronHooks(process.env.TRONHOOKS_API_KEY!); // keep the key out of source control and prompts
const watch = await th.watches.create({
  address: process.env.TRON_ADDRESS!, // address you intend to monitor; review before running
  assetFilter: 'ALL', // USDT | TRX | ALL (ALL means USDT + TRX)
  direction: 'incoming', // incoming | outgoing | both
  webhookUrl: 'https://your.app/tron-webhook',
});
// store watch.secret — it is shown exactly once
```

Telegram (connect your own Telegram in the console first):

```ts
const watch = await th.watches.create({
  address: process.env.TRON_ADDRESS!, assetFilter: 'USDT',
  direction: 'both', telegram: true,
});
// channel === 'telegram', webhook_url === null; no signing secret.
```

These POSTs create real watches and enable future notifications. Preview the inputs and obtain the account holder's approval before execution. On a timeout, list watches and reconcile; never blindly repeat an uncertain write. `409` means an existing watch; `402` means quota, which can take precedence over duplicate detection. Billing is closed. Free accounts have 3 active watches and 60 API requests/minute.

For a complete receiver, download the [Node example](https://tronhooks.com/docs/ai/examples/receiver.mjs) or [Python example](https://tronhooks.com/docs/ai/examples/receiver.py). They verify the raw body and commit a durable inbox row before returning 2xx, including restart-safe deduplication and retryable storage failures. Run their `--self-test` mode offline before configuring a real watch. A signature helper by itself is not a durable receiver.

```ts
// Verification only: use exact bytes from the HTTP request, before JSON parsing.
const event = constructEvent(rawBody, signatureHeader, process.env.TRONHOOKS_WEBHOOK_SECRET!);
// Keep event.amount as a string. Persist/dedupe before acknowledging delivery.
```

## Reconciliation

Webhook receiver was down? Page through past events:

```ts
for await (const ev of th.events.iterate({ since: '2026-08-01T00:00:00Z' })) {
  console.log(ev.event_id, ev.amount, ev.delivery.status);
}
```

## Notes

- Keys are network-bound by prefix; the hosted service is mainnet-only (`tw_live_…`). `tw_test_…` is reserved for a future testnet environment.
- Amounts are decimal **strings** (`amount`) plus smallest-unit `amount_raw` —
  never floats. Native TRX transfers have `event_index: 0` by convention.
- Retries: immediate, then 1m/5m/30m/2h/6h; failed-out notifications are
  visible via `events.list()` (`delivery.status === 'DEAD'`).
- Requests have a 10-second timeout (configurable); redirects are rejected. There are no automatic write retries.
- Errors expose the raw `retryAfter` header for 429 handling; use bounded read retries. Pass opaque `next_cursor` strings unchanged; stable server ordering includes a notification-ID tie-breaker. Repeated cursors stop iteration with an error. Deleted-watch history cannot be reconciled after cascade deletion.
- Version 0.2 adds Telegram/direction types. A listed watch is a channel-discriminated union; webhook URLs are null for Telegram.
- Errors carry `status` and `code` (`quota_exceeded`, `wrong_network`,
  `rate_limited`…) — see the [docs](https://tronhooks.com) for the full table.

## Contributing

Issues and PRs welcome. `npm ci && npm test` — zero runtime dependencies, keep it that way.
The hosted service itself is closed-source; this client is MIT.

MIT © tronhooks.com
