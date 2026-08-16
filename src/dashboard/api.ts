import os from 'node:os';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Telegram } from 'telegraf';
import { prisma } from '../core/database';
import { env, isProd } from '../config/env';
import { isBotOwner } from '../utils/permissions';
import { memberCount, totalMessages, topByMessages } from '../services/member.service';
import { addReply, deleteReply, listReplies } from '../services/replies.service';
import { addFilter, deleteFilter, listFilters } from '../services/filters.service';
import { TOGGLEABLE_SETTINGS } from '../services/settings.service';
import { queryLogs, queryMedia, logAnalytics, listConversants, userConversation } from '../services/logging.service';
import { recentMessages as recentMusaraha } from '../services/musaraha.service';
import { recentWhispers } from '../services/whisper.service';
import { youtubeQueue } from '../services/youtube/queue';
import { recentErrors, clearErrors } from '../core/errors';
import {
  SESSION_COOKIE,
  readCookie,
  signSession,
  verifySession,
  verifyTelegramLogin,
  type TelegramLoginData,
} from './auth';

/** JSON responder that safely stringifies BigInt (chat/user ids) as strings. */
function json(res: Response, data: unknown, status = 200): void {
  res
    .status(status)
    .type('application/json')
    .send(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

interface AuthedRequest extends Request {
  userId?: number;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  const userId = verifySession(token);
  if (!userId || !isBotOwner(userId)) {
    json(res, { error: 'unauthorized' }, 401);
    return;
  }
  req.userId = userId;
  next();
}

/** Whitelisted settings fields the dashboard may update. */
const NUMERIC_FIELDS = ['maxWarnings', 'floodLimit', 'floodWindowSec', 'captchaTimeoutSec', 'nightStartHour', 'nightEndHour'];
const STRING_FIELDS = ['rules', 'welcomeMessage', 'farewellMessage', 'welcomeImageUrl', 'warnAction', 'moderationAction'];

/** Record an owner action in the dashboard audit trail. */
async function audit(actorId: number | undefined, action: string, details?: string): Promise<void> {
  if (!actorId) return;
  await prisma.dashboardAudit.create({ data: { actorId: BigInt(actorId), action, details: details ?? null } }).catch(() => undefined);
}

export function createDashboardApi(telegram: Telegram): express.Router {
  const router = express.Router();

  router.get('/config', (_req, res) => json(res, { botUsername: env.BOT_USERNAME ?? '' }));

  router.post('/auth/telegram', (req, res) => {
    const userId = verifyTelegramLogin(req.body as TelegramLoginData);
    if (!userId) return json(res, { error: 'invalid_login' }, 403);
    if (!isBotOwner(userId)) return json(res, { error: 'not_owner' }, 403);
    const token = signSession(userId);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax${isProd ? '; Secure' : ''}`,
    );
    json(res, { ok: true, userId });
  });

  router.post('/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    json(res, { ok: true });
  });

  router.get('/me', (req: AuthedRequest, res) => {
    const userId = verifySession(readCookie(req.headers.cookie, SESSION_COOKIE));
    json(res, { authenticated: Boolean(userId && isBotOwner(userId)), userId: userId ?? null });
  });

  // ---- Everything below requires an authenticated owner ----
  router.use(requireAuth);

  router.get('/chats', async (_req, res) => {
    const chats = await prisma.chat.findMany({ orderBy: { updatedAt: 'desc' } });
    json(res, chats.map((c) => ({ id: c.id.toString(), title: c.title, type: c.type, language: c.language })));
  });

  router.get('/chats/:id/settings', async (req, res) => {
    const s = await prisma.chatSettings.findUnique({ where: { chatId: BigInt(req.params.id) } });
    if (!s) return json(res, { error: 'not_found' }, 404);
    json(res, s);
  });

  router.patch('/chats/:id/settings', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const key of TOGGLEABLE_SETTINGS) if (typeof body[key] === 'boolean') data[key] = body[key];
    for (const key of NUMERIC_FIELDS) if (typeof body[key] === 'number') data[key] = body[key];
    for (const key of STRING_FIELDS) if (typeof body[key] === 'string') data[key] = body[key];
    if (!Object.keys(data).length) return json(res, { error: 'no_valid_fields' }, 400);
    const updated = await prisma.chatSettings.update({ where: { chatId: BigInt(req.params.id) }, data });
    await audit((req as AuthedRequest).userId, 'settings', `chat=${req.params.id} ${Object.keys(data).join(',')}`);
    json(res, updated);
  });

  router.get('/chats/:id/stats', async (req, res) => {
    const id = BigInt(req.params.id);
    const [members, messages, top] = await Promise.all([
      memberCount(id),
      totalMessages(id),
      topByMessages(id, 10),
    ]);
    json(res, {
      members,
      messages,
      top: top.map((m) => ({ name: m.firstName ?? m.username ?? m.userId.toString(), messages: m.messageCount, xp: m.xp, level: m.level })),
    });
  });

  router.get('/chats/:id/replies', async (req, res) => {
    const rows = await listReplies(BigInt(req.params.id));
    json(res, rows.map((r) => ({ trigger: r.trigger, responses: safeParse(r.responses), matchType: r.matchType })));
  });
  router.post('/chats/:id/replies', async (req, res) => {
    const { trigger, responses } = (req.body ?? {}) as { trigger?: string; responses?: string[] };
    if (!trigger || !Array.isArray(responses) || !responses.length) return json(res, { error: 'bad_input' }, 400);
    await addReply(BigInt(req.params.id), trigger, responses, 0);
    json(res, { ok: true });
  });
  router.delete('/chats/:id/replies/:trigger', async (req, res) => {
    const ok = await deleteReply(BigInt(req.params.id), req.params.trigger);
    json(res, { ok });
  });

  router.get('/chats/:id/filters', async (req, res) => {
    const rows = await listFilters(BigInt(req.params.id));
    json(res, rows.map((f) => ({ word: f.word, action: f.action })));
  });
  router.post('/chats/:id/filters', async (req, res) => {
    const { word } = (req.body ?? {}) as { word?: string };
    if (!word) return json(res, { error: 'bad_input' }, 400);
    await addFilter(BigInt(req.params.id), word);
    json(res, { ok: true });
  });
  router.delete('/chats/:id/filters/:word', async (req, res) => {
    const ok = await deleteFilter(BigInt(req.params.id), req.params.word);
    json(res, { ok });
  });

  // ---- Super Admin: monitor / media / logs / analytics / system ----

  router.get('/monitor', async (req, res) => {
    const q = req.query as Record<string, string>;
    const rows = await queryLogs({ chatId: q.chatId, type: q.type, limit: Number(q.limit) || 60, before: q.before ? Number(q.before) : undefined });
    json(res, rows);
  });

  router.get('/logs', async (req, res) => {
    const q = req.query as Record<string, string>;
    const rows = await queryLogs({
      chatId: q.chatId,
      userId: q.userId,
      type: q.type,
      q: q.q,
      flagged: q.flagged === 'true' ? true : undefined,
      limit: Number(q.limit) || 60,
      before: q.before ? Number(q.before) : undefined,
    });
    json(res, rows);
  });

  // Per-user conversation view: who talked to the bot, and each user's history.
  router.get('/users', async (_req, res) => json(res, await listConversants(300)));

  router.get('/users/:id/conversation', async (req, res) => {
    const q = req.query as Record<string, string>;
    const rows = await userConversation(req.params.id, q.chatId, q.before ? Number(q.before) : undefined, Number(q.limit) || 200, q.q || undefined);
    json(res, rows);
  });

  // Owner replies to a user *from the bot* in DM. Telegram only allows this if
  // the user has previously started the bot in a private chat.
  router.post('/users/:id/message', async (req: AuthedRequest, res) => {
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text?.trim()) return json(res, { error: 'bad_input' }, 400);
    try {
      await telegram.sendMessage(Number(req.params.id), text.trim());
      await audit(req.userId, 'dm', `user=${req.params.id}`);
      json(res, { ok: true });
    } catch {
      // 403 = user never started the bot / blocked it.
      json(res, { error: 'cannot_message', hint: 'المستخدم لم يبدأ محادثة البوت أو حظره.' }, 502);
    }
  });

  router.get('/media', async (req, res) => {
    const q = req.query as Record<string, string>;
    json(res, await queryMedia(q.chatId, q.type, Number(q.limit) || 40));
  });

  // Resolve a media file to a temporary Telegram URL (owner-only, ≤20MB files).
  router.get('/media/:id/link', async (req, res) => {
    const row = await prisma.messageLog.findUnique({ where: { id: Number(req.params.id) } });
    if (!row?.fileId) return json(res, { error: 'not_found' }, 404);
    try {
      const link = await telegram.getFileLink(row.fileId);
      json(res, { url: link.toString() });
    } catch {
      json(res, { error: 'too_large_or_expired' }, 502);
    }
  });

  // Stream a media file's bytes through the server so photos/stickers render
  // inline in the dashboard WITHOUT leaking the bot token into the browser
  // (the raw Telegram file URL embeds the token). Owner-only, ≤20MB.
  router.get('/media/:id/raw', async (req, res) => {
    const row = await prisma.messageLog.findUnique({ where: { id: Number(req.params.id) } });
    if (!row?.fileId) return void res.status(404).end();
    try {
      const link = await telegram.getFileLink(row.fileId);
      const upstream = await fetch(link.toString());
      if (!upstream.ok || !upstream.body) return void res.status(502).end();
      const path = new URL(link.toString()).pathname.toLowerCase();
      const ext = path.slice(path.lastIndexOf('.') + 1);
      const mime: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
        gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
        ogg: 'audio/ogg', oga: 'audio/ogg', tgs: 'application/gzip',
      };
      res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    } catch {
      res.status(502).end();
    }
  });

  router.get('/analytics', async (_req, res) => json(res, await logAnalytics()));

  router.get('/system', (_req, res) => {
    const mem = process.memoryUsage();
    json(res, {
      uptimeSec: Math.round(process.uptime()),
      memory: { rssMB: +(mem.rss / 1048576).toFixed(1), heapMB: +(mem.heapUsed / 1048576).toFixed(1) },
      loadavg: os.loadavg().map((n) => +n.toFixed(2)),
      cpus: os.cpus().length,
      queue: youtubeQueue.stats(),
      errors: recentErrors().slice(0, 30),
      node: process.version,
    });
  });

  router.get('/musaraha', async (req, res) => {
    const q = req.query as Record<string, string>;
    json(res, await recentMusaraha(Number(q.limit) || 80));
  });

  router.get('/whispers', async (req, res) => {
    const q = req.query as Record<string, string>;
    json(res, await recentWhispers(Number(q.limit) || 80));
  });

  router.get('/audit', async (_req, res) => {
    const rows = await prisma.dashboardAudit.findMany({ orderBy: { id: 'desc' }, take: 100 });
    json(res, rows);
  });

  // Owner actions.
  router.post('/chats/:id/broadcast', async (req: AuthedRequest, res) => {
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text) return json(res, { error: 'bad_input' }, 400);
    try {
      await telegram.sendMessage(Number(req.params.id), text);
      await audit(req.userId, 'broadcast', `chat=${req.params.id}`);
      json(res, { ok: true });
    } catch {
      json(res, { error: 'send_failed' }, 502);
    }
  });

  router.post('/system/clearcache', async (req: AuthedRequest, res) => {
    clearErrors();
    await audit(req.userId, 'clearcache');
    json(res, { ok: true });
  });

  router.post('/system/restart', async (req: AuthedRequest, res) => {
    await audit(req.userId, 'restart');
    json(res, { ok: true, note: 'restarting' });
    setTimeout(() => process.exit(0), 400); // Railway/Render restarts the process
  });

  return router;
}

function safeParse(raw: string): string[] {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
