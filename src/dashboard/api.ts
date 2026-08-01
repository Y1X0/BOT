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
import { queryLogs, queryMedia, logAnalytics } from '../services/logging.service';
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
