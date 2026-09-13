/**
 * Fragment Stars auto-buy (opt-in, best-effort).
 *
 * Fragment has NO official API, so this drives its internal endpoints the same
 * way the website does, then pays with the configured wallet. It is:
 *   • OFF unless FRAGMENT_AUTOBUY=true and TON_MNEMONIC + FRAGMENT_COOKIES are set
 *   • conservative: it only ever sends the EXACT transaction Fragment returns
 *     (address + amount + payload), so it can't mis-send funds; the worst failure
 *     mode is "no purchase", which the caller handles by asking the owner to fulfil
 *   • guarded by FRAGMENT_MAX_STARS
 *
 * Fragment changes its endpoints and its anti-bot checks periodically, and the
 * session cookies expire, so treat this as needing occasional maintenance. Every
 * step logs and returns a typed result; nothing throws.
 */
import { env } from '../config/env';
import { logger } from '../core/logger';

const log = logger.child({ mod: 'fragment' });

export type BuyResult =
  | { ok: true; ref: string }
  | { ok: false; error: string; retryable: boolean };

export function autobuyConfigured(): boolean {
  return env.FRAGMENT_AUTOBUY && !!env.TON_MNEMONIC && !!env.FRAGMENT_COOKIES;
}

const FRAGMENT = 'https://fragment.com';

function headers(): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: FRAGMENT,
    Referer: `${FRAGMENT}/stars`,
    Cookie: env.FRAGMENT_COOKIES ?? '',
  };
}

/** Scrape the rolling `hash` Fragment's front-end signs every request with. */
async function fetchApiHash(): Promise<string | null> {
  try {
    const res = await fetch(`${FRAGMENT}/stars`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
    const html = await res.text();
    const m = /\/api\?hash=([a-f0-9]+)/i.exec(html) || /"hash":"([a-f0-9]+)"/i.exec(html);
    return m ? m[1] : null;
  } catch (err) {
    log.warn({ err }, 'fetchApiHash failed');
    return null;
  }
}

async function api(hash: string, body: Record<string, string>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${FRAGMENT}/api?hash=${hash}`, {
      method: 'POST',
      headers: headers(),
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch (err) {
    log.warn({ err, method: body.method }, 'fragment api call failed');
    return null;
  }
}

/**
 * Buy `stars` Stars for a bare username (no @). Returns a typed result; the
 * caller falls back to manual fulfilment on any failure.
 */
export async function buyStars(username: string, stars: number): Promise<BuyResult> {
  if (!autobuyConfigured()) return { ok: false, error: 'disabled', retryable: false };
  if (stars <= 0 || stars > env.FRAGMENT_MAX_STARS)
    return { ok: false, error: `stars_out_of_range(max ${env.FRAGMENT_MAX_STARS})`, retryable: false };
  const recipient = username.replace(/^@/, '').trim();
  if (!recipient) return { ok: false, error: 'no_recipient', retryable: false };

  const hash = await fetchApiHash();
  if (!hash) return { ok: false, error: 'no_hash', retryable: true };

  // 1) Resolve the recipient.
  const search = await api(hash, { method: 'searchStarsRecipient', query: recipient, quantity: String(stars) });
  const found = search?.found as { recipient?: string; myself?: boolean } | undefined;
  if (!search?.ok || !found?.recipient) {
    return { ok: false, error: `recipient_not_found(${recipient})`, retryable: false };
  }

  // 2) Prepare the purchase request.
  const init = await api(hash, {
    method: 'initBuyStarsRequest',
    recipient: found.recipient,
    quantity: String(stars),
  });
  const reqId = init?.req_id as string | undefined;
  if (!init?.ok || !reqId) return { ok: false, error: 'init_failed', retryable: true };

  // 3) Ask Fragment for the exact on-chain transaction to sign, then pay it.
  //    (account/device describe the connected TON-Connect wallet; they must match
  //     the wallet whose mnemonic we hold.)
  const { walletAccountParam, deviceParam } = await import('./ton-wallet').then((m) => m.tonConnectDescriptors());
  const link = await api(hash, {
    method: 'getBuyStarsLink',
    account: walletAccountParam,
    device: deviceParam,
    transaction: '1',
    id: reqId,
    show_sender: '0',
  });
  const tx = link?.transaction as { messages?: { address: string; amount: string; payload?: string }[] } | undefined;
  if (!link?.ok || !tx?.messages?.length) return { ok: false, error: 'no_transaction_link', retryable: true };

  // 4) Sign & broadcast exactly what Fragment returned — never our own amounts.
  const send = await import('./ton-wallet').then((m) => m.sendMessages(tx.messages!));
  if (!send.ok) return { ok: false, error: `send_failed:${send.error}`, retryable: true };

  log.info({ recipient, stars, reqId }, 'fragment auto-buy sent');
  return { ok: true, ref: reqId };
}
