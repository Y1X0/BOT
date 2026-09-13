/**
 * TON payment detection (read-only). Polls toncenter for incoming transfers to
 * the bot's wallet and matches them by the unique text comment attached to each
 * order. No private key is used here — this only reads the public chain, so it's
 * safe. Fragment auto-buy (which does sign transactions) lives in fragment.service.
 */
import { toNano, fromNano } from '@ton/core';
import { env } from '../config/env';
import { logger } from '../core/logger';

const log = logger.child({ mod: 'ton' });

export interface DetectedPayment {
  hash: string;
  nanoTon: bigint;
  from?: string;
}

/** Convert a TON decimal amount to nanotons (bigint). */
export function toNanoTon(ton: number | string): bigint {
  return toNano(typeof ton === 'number' ? ton.toFixed(9) : ton);
}

export function fromNanoTon(nano: bigint | string): string {
  return fromNano(typeof nano === 'bigint' ? nano : BigInt(nano));
}

interface TonMsg {
  value?: string;
  source?: string;
  message?: string; // decoded text comment (toncenter)
  msg_data?: { text?: string; body?: string };
}
interface TonTx {
  transaction_id?: { hash?: string; lt?: string };
  in_msg?: TonMsg;
}

function commentOf(msg: TonMsg | undefined): string {
  if (!msg) return '';
  return (msg.message || msg.msg_data?.text || '').trim();
}

/**
 * Look for an incoming payment carrying `comment` worth at least `minNanoTon`.
 * Returns the matching transaction, or null if none yet.
 */
export async function findPaymentByComment(comment: string, minNanoTon: bigint, limit = 40): Promise<DetectedPayment | null> {
  const address = env.TON_WALLET_ADDRESS;
  if (!address) return null;
  const url = new URL(`${env.TON_API_BASE.replace(/\/+$/, '')}/getTransactions`);
  url.searchParams.set('address', address);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('archival', 'true');
  if (env.TON_API_KEY) url.searchParams.set('api_key', env.TON_API_KEY);

  let data: { ok?: boolean; result?: TonTx[] };
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      log.warn({ status: res.status }, 'toncenter getTransactions failed');
      return null;
    }
    data = (await res.json()) as { ok?: boolean; result?: TonTx[] };
  } catch (err) {
    log.warn({ err }, 'toncenter request error');
    return null;
  }
  for (const tx of data.result ?? []) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;
    if (commentOf(inMsg) !== comment) continue;
    let value: bigint;
    try {
      value = BigInt(inMsg.value ?? '0');
    } catch {
      continue;
    }
    if (value >= minNanoTon) {
      return { hash: tx.transaction_id?.hash ?? '', nanoTon: value, from: inMsg.source };
    }
  }
  return null;
}

/** Is TON payment detection configured (a receiving address is set)? */
export function tonConfigured(): boolean {
  return !!env.TON_WALLET_ADDRESS;
}
