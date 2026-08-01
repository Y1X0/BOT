import express, { type Request, type Response, type NextFunction } from 'express';
import { prisma } from '../core/database';
import { env, isProd } from '../config/env';
import { isBotOwner } from '../utils/permissions';
import { memberCount, totalMessages, topByMessages } from '../services/member.service';
import { addReply, deleteReply, listReplies } from '../services/replies.service';
import { addFilter, deleteFilter, listFilters } from '../services/filters.service';
import { TOGGLEABLE_SETTINGS } from '../services/settings.service';
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
const STRING_FIELDS = ['rules', 'welcomeMessage', 'farewellMessage', 'welcomeImageUrl', 'warnAction'];

export function createDashboardApi(): express.Router {
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
