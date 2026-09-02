# @tronhooks/sdk

TRON deposit webhooks for developers — watch USDT/TRX addresses, get signed
webhooks on confirmed transfers, verify in one line. Client for
[tronhooks.com](https://tronhooks.com).

[![npm](https://img.shields.io/npm/v/@tronhooks/sdk)](https://www.npmjs.com/package/@tronhooks/sdk)
[![ci](https://github.com/LuganBI/tronhooks-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/LuganBI/tronhooks-sdk/actions)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

Docs: [Quickstart](https://tronhooks.com/docs/quickstart/) · [API reference](https://tronhooks.com/docs/api/) · [OpenAPI](https://tronhooks.com/docs/openapi.json) · [Verifying signatures](https://tronhooks.com/docs/webhooks/) · [Error codes](https://tronhooks.com/docs/errors/)

```bash
npm install @tronhooks/sdk
```

## Three lines to your first webhook

```ts
import { TronHooks, constructEvent } from '@tronhooks/sdk';

const th = new TronHooks('tw_live_…'); // key from https://tronhooks.com console
const watch = await th.watches.create({
  address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  assetFilter: 'ALL', // USDT | TRX | ALL
  webhookUrl: 'https://your.app/tron-webhook',
});
// store watch.secret — it is shown exactly once
```

In your webhook handler (Express example — note the **raw** body):

```ts
app.post('/tron-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const event = constructEvent(req.body, req.header('x-signature'), WATCH_SECRET);
  // event.asset, event.amount ("1.99"), event.from, event.to, event.tx_id …
  // deliveries are at-least-once → dedupe on event.event_id
  res.sendStatus(200);
});
```

## Reconciliation (never miss a deposit)

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
- Errors carry `status` and `code` (`quota_exceeded`, `wrong_network`,
  `rate_limited`…) — see the [docs](https://tronhooks.com) for the full table.

## Contributing

Issues and PRs welcome. `npm ci && npm test` — zero runtime dependencies, keep it that way.
The hosted service itself is closed-source; this client is MIT.

MIT © tronhooks.com
