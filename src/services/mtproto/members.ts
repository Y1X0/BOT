/**
 * List a group's FULL member roster from inside the BOT process via MTProto
 * (gramjs), logging in with the bot's own token. This is what lets «@الكل» reach
 * everyone WITHOUT the music/streamer service and without relying on who has
 * talked — the bot is always awake, so no cold-start, no "first time" wait.
 *
 * A short-lived connection per call (updates never subscribed) so it can't
 * collide with Telegraf's Bot-API long polling. The gramjs session string is
 * cached in GlobalConfig so repeat calls skip the login handshake.
 */
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { LogLevel } from 'telegram/extensions/Logger';
import bigInt from 'big-integer';
import { env } from '../../config/env';
import { getGlobal, setGlobal } from '../global.service';
import { createLogger } from '../../core/logger';

const log = createLogger('mtproto:members');
const SESSION_KEY = 'mtprotoBotSession';

export type Member = { id: number; name: string };

let lastError = '';
export function getLastMtprotoError(): string {
  return lastError;
}

/** True when API_ID/API_HASH/BOT_TOKEN are all present. */
export function mtprotoConfigured(): boolean {
  return Boolean(env.API_ID && env.API_HASH && env.BOT_TOKEN);
}

/**
 * Fetch every member of a supergroup as {id, name}. Returns null if not
 * configured or on any failure (caller falls back). Bots are allowed to call
 * channels.getParticipants, so this works in any group the bot administers.
 */
export async function fetchChatMembersViaBot(chatId: number): Promise<Member[] | null> {
  if (!mtprotoConfigured()) {
    lastError = 'API_ID/API_HASH/BOT_TOKEN not set';
    return null;
  }
  lastError = '';
  const saved = (await getGlobal(SESSION_KEY)) || '';
  const session = new StringSession(saved);
  const client = new TelegramClient(session, env.API_ID as number, env.API_HASH as string, {
    connectionRetries: 2,
    autoReconnect: false,
    // Never emit our own request logs to the console.
    baseLogger: undefined,
  });
  try {
    client.setLogLevel(LogLevel.NONE);
  } catch {
    /* older gramjs — ignore */
  }
  try {
    // Only supergroups/channels (-100…) support channels.getParticipants.
    const s = String(chatId);
    if (!s.startsWith('-100')) {
      lastError = 'not a supergroup';
      return null;
    }
    const channelId = bigInt(s.slice(4));

    await client.start({ botAuthToken: env.BOT_TOKEN });
    // Persist the session so the next call reconnects without re-auth.
    if (!saved) {
      const sess = client.session.save();
      if (typeof sess === 'string' && sess) await setGlobal(SESSION_KEY, sess).catch(() => undefined);
    }

    // Raw channels.getParticipants with accessHash=0 — Telegram lets a BOT that
    // is a member resolve the channel this way (the same behavior that makes the
    // Pyrogram path work). Avoids gramjs entity resolution, which needs a dialog
    // cache a bot doesn't have. Paginate in pages of 200.
    const channel = new Api.InputChannel({ channelId, accessHash: bigInt(0) });
    const seen = new Set<number>();
    const out: Member[] = [];
    let offset = 0;
    const limit = 200;
    for (;;) {
      const res = (await client.invoke(
        new Api.channels.GetParticipants({
          channel,
          filter: new Api.ChannelParticipantsRecent(),
          offset,
          limit,
          hash: bigInt(0),
        }),
      )) as unknown as {
        users?: { id?: unknown; firstName?: string; lastName?: string; username?: string; bot?: boolean; deleted?: boolean }[];
        participants?: unknown[];
      };
      const users = res.users ?? [];
      for (const user of users) {
        if (user.bot || user.deleted) continue;
        const id = Number(user.id);
        if (!Number.isFinite(id) || seen.has(id)) continue;
        seen.add(id);
        const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'عضو';
        out.push({ id, name });
      }
      const got = (res.participants ?? []).length;
      offset += got;
      if (got < limit || out.length >= 5000) break;
    }
    return out.length ? out : null;
  } catch (e) {
    const err = e as { errorMessage?: string; className?: string; message?: string };
    lastError = String(err.errorMessage || err.className || err.message || e).slice(0, 200);
    log.warn({ err: lastError, chatId }, 'gramjs getParticipants failed');
    // A bad cached session can wedge every call — clear it so the next retries fresh.
    if (/AUTH|SESSION|KEY/i.test(lastError)) await setGlobal(SESSION_KEY, null).catch(() => undefined);
    return null;
  } finally {
    await client.disconnect().catch(() => undefined);
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
  }
}
