/**
 * Wire types for the tronhooks.com API.
 * The webhook payload shape mirrors @tronwebhook/shared (bundled at build
 * time) and is versioned via `api_version` — additive-only within a version.
 */

export type Network = 'mainnet' | 'nile';
export type Asset = 'USDT' | 'TRX';
export type AssetFilter = 'USDT' | 'TRX' | 'ALL';
export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'DEAD';

/** A confirmed on-chain transfer matched against one of your watches. */
export interface TransferEvent {
  api_version: string;
  event_id: string;
  type: 'transfer.confirmed';
  network: Network;
  asset: Asset;
  /** TRC-20 contract address (base58), null for native TRX */
  contract: string | null;
  tx_id: string;
  /** Transfer log index in the tx receipt; native TRX transfers are always 0 */
  event_index: number;
  block_number: number;
  block_timestamp: string;
  from: string;
  to: string;
  /** integer amount in the asset's smallest unit (6 decimals), as a string */
  amount_raw: string;
  /** human-readable decimal string — never a float */
  amount: string;
  watch_id: string;
}

export interface Watch {
  id: string;
  address: string;
  asset_filter: AssetFilter;
  webhook_url: string;
  status: string;
  created_at: string;
}

export interface CreatedWatch extends Watch {
  /** webhook signing secret — returned ONCE at creation, store it now */
  secret: string;
  note?: string;
}

export interface EventListItem extends TransferEvent {
  delivery: {
    notification_id: string;
    status: DeliveryStatus;
    attempts: number;
    created_at: string;
  };
}

export interface EventPage {
  data: EventListItem[];
  next_before: string | null;
}
