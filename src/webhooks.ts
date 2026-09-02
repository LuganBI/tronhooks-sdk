import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TransferEvent } from './types.js';

/**
 * Verify a webhook signature: X-Signature = hex(HMAC-SHA256(secret, rawBody)).
 * Constant-time comparison; safe against timing attacks.
 *
 * IMPORTANT: pass the RAW request body exactly as received (string or
 * Buffer), not a re-serialized object — JSON key order matters.
 */
export function verifySignature(
  rawBody: string | Uint8Array,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class SignatureVerificationError extends Error {
  constructor() {
    super(
      'Webhook signature verification failed. Check that you passed the raw request body and the whsec_ secret of the matching watch.',
    );
  }
}

/**
 * Verify + parse in one step (use inside your webhook handler):
 *
 *   const event = constructEvent(rawBody, req.headers['x-signature'], secret);
 *
 * Throws SignatureVerificationError on mismatch. Deliveries are
 * at-least-once — dedupe on `event.event_id`.
 */
export function constructEvent(
  rawBody: string | Uint8Array,
  signature: string | undefined,
  secret: string,
): TransferEvent {
  if (!verifySignature(rawBody, signature, secret)) throw new SignatureVerificationError();
  const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  return JSON.parse(text) as TransferEvent;
}
