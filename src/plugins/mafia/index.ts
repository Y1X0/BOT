import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:mafia');

type Role = 'mafia' | 'doctor' | 'detective' | 'citizen';
const ROLE_AR: Record<Role, string> = {
  mafia: '🔫 مافيا',
  doctor: '💉 طبيب',
  detective: '🕵️ محقق',
  citizen: '👤 مواطن',
};

interface Player {
  id: number;
  name: string;
  role: Role;
  alive: boolean;
}
interface Game {
  chatId: number;
  hostId: number;
  phase: 'lobby' | 'night' | 'day' | 'ended';
  players: Map<number, Player>;
  round: number;
  night: { kill?: number; save?: number; check?: number };
  votes: Map<number, number>;
  timer?: NodeJS.Timeout;
  resolving?: boolean; // re-entrancy guard so a phase never resolves twice
}

const games = new Map<number, Game>();
const playerGame = new Map<number, number>(); // userId → chatId
const LOBBY_MIN = 4;
const NIGHT_MS = 60_000;
const DAY_MS = 60_000;

const alive = (g: Game) => [...g.players.values()].filter((p) => p.alive);
const aliveMafia = (g: Game) => alive(g).filter((p) => p.role === 'mafia');

function targetKeyboard(players: Player[], action: string) {
  return Markup.inlineKeyboard(
    players.map((p) => [Markup.button.callback(p.name, `maf:${action}:${p.id}`)]),
  );
}

export const mafiaPlugin: Plugin = {
  name: 'mafia',
  description: 'Mafia party game (lobby → roles in DM → night/day → win)',
  commands: [
    { command: 'mafia', description: '🔫 بدء لعبة مافيا' },
    { command: 'mafiastop', description: '🛑 إيقاف لعبة المافيا', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('mafia', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      if (games.has(ctx.chat.id)) return void ctx.reply('🔫 توجد لعبة جارية. /mafiastop لإيقافها.');
      const g: Game = {
        chatId: ctx.chat.id,
        hostId: ctx.from.id,
        phase: 'lobby',
        players: new Map(),
        round: 0,
        night: {},
        votes: new Map(),
      };
      games.set(ctx.chat.id, g);
      await ctx.reply(
        '🔫 لعبة المافيا!\nاضغط «انضمام» للمشاركة (لازم تبدأ محادثة خاصة مع البوت أولاً).\nالمضيف يضغط «ابدأ» عند اكتمال اللاعبين.',
        Markup.inlineKeyboard([
          [Markup.button.callback('✋ انضمام', 'maf:join')],
          [Markup.button.callback('▶️ ابدأ', 'maf:begin')],
        ]),
      );
    });

    bot.command('mafiastop', requireRole('admin'), async (ctx) => {
      if (!ctx.chat) return;
      const g = games.get(ctx.chat.id);
      if (!g) return void ctx.reply('لا توجد لعبة جارية.');
      cleanup(g);
      await ctx.reply('🛑 تم إيقاف لعبة المافيا.');
    });

    // Join (must be DM-able).
    bot.action('maf:join', async (ctx) => {
      const g = games.get(ctx.chat!.id);
      if (!g || g.phase !== 'lobby' || !ctx.from) return void ctx.answerCbQuery('لا يوجد انضمام الآن.').catch(() => undefined);
      if (g.players.has(ctx.from.id)) return void ctx.answerCbQuery('أنت منضم بالفعل.').catch(() => undefined);
      try {
        await ctx.telegram.sendMessage(ctx.from.id, '✋ انضممت للعبة المافيا! انتظر بدء اللعبة.');
      } catch {
        return void ctx.answerCbQuery('⚠️ ابدأ محادثة خاصة مع البوت أولاً ثم انضم.', { show_alert: true }).catch(() => undefined);
      }
      const name = ctx.from.first_name ?? 'لاعب';
      g.players.set(ctx.from.id, { id: ctx.from.id, name, role: 'citizen', alive: true });
      playerGame.set(ctx.from.id, g.chatId);
      await ctx.answerCbQuery('انضممت ✅').catch(() => undefined);
      await ctx
        .editMessageText(
          `🔫 لعبة المافيا! المنضمّون (${g.players.size}):\n${[...g.players.values()].map((p) => `• ${p.name}`).join('\n')}`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✋ انضمام', 'maf:join')],
            [Markup.button.callback('▶️ ابدأ', 'maf:begin')],
          ]),
        )
        .catch(() => undefined);
    });

    // Host begins.
    bot.action('maf:begin', async (ctx) => {
      const g = games.get(ctx.chat!.id);
      if (!g || g.phase !== 'lobby') return void ctx.answerCbQuery().catch(() => undefined);
      if (ctx.from?.id !== g.hostId) return void ctx.answerCbQuery('المضيف فقط يبدأ اللعبة.', { show_alert: true }).catch(() => undefined);
      if (g.players.size < LOBBY_MIN) return void ctx.answerCbQuery(`تحتاج ${LOBBY_MIN} لاعبين على الأقل.`, { show_alert: true }).catch(() => undefined);
      await ctx.answerCbQuery().catch(() => undefined);
      await assignRoles(ctx.telegram, g);
      await beginNight(ctx.telegram, g);
    });

    // Night actions (from DM).
    bot.action(/^maf:(kill|save|check):(\d+)$/, async (ctx) => {
      const action = ctx.match[1] as 'kill' | 'save' | 'check';
      const targetId = Number(ctx.match[2]);
      const chatId = ctx.from ? playerGame.get(ctx.from.id) : undefined;
      const g = chatId ? games.get(chatId) : undefined;
      if (!g || g.phase !== 'night' || !ctx.from) return void ctx.answerCbQuery().catch(() => undefined);
      const actor = g.players.get(ctx.from.id);
      if (!actor?.alive) return void ctx.answerCbQuery('لا يمكنك التصرف.').catch(() => undefined);

      if (action === 'kill' && actor.role === 'mafia') g.night.kill = targetId;
      else if (action === 'save' && actor.role === 'doctor') g.night.save = targetId;
      else if (action === 'check' && actor.role === 'detective') {
        g.night.check = targetId;
        const t = g.players.get(targetId);
        await ctx.reply(`🔍 ${t?.name}: ${t?.role === 'mafia' ? 'مافيا 🔫' : 'بريء ✅'}`).catch(() => undefined);
      } else {
        return void ctx.answerCbQuery('ليس دورك.').catch(() => undefined);
      }
      await ctx.answerCbQuery('تم اختيارك ✅').catch(() => undefined);
      await maybeResolveNight(ctx.telegram, g);
    });

    // Day vote (in group).
    bot.action(/^maf:vote:(\d+)$/, async (ctx) => {
      const g = games.get(ctx.chat!.id);
      if (!g || g.phase !== 'day' || !ctx.from) return void ctx.answerCbQuery().catch(() => undefined);
      const voter = g.players.get(ctx.from.id);
      if (!voter?.alive) return void ctx.answerCbQuery('غير المشاركين لا يصوّتون.').catch(() => undefined);
      g.votes.set(ctx.from.id, Number(ctx.match[1]));
      await ctx.answerCbQuery('تم تصويتك ✅').catch(() => undefined);
      if (g.votes.size >= alive(g).length) await resolveDay(ctx.telegram, g);
    });
  },
};

async function assignRoles(telegram: BotContext['telegram'], g: Game): Promise<void> {
  // Fisher-Yates: a uniform shuffle (sort(()=>Math.random()-0.5) is biased).
  const ids = [...g.players.keys()];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const n = ids.length;
  const mafiaCount = n >= 6 ? 2 : 1;
  const roles: Role[] = [];
  for (let i = 0; i < mafiaCount; i++) roles.push('mafia');
  roles.push('doctor');
  if (n >= 5) roles.push('detective');
  while (roles.length < n) roles.push('citizen');

  ids.forEach((id, i) => {
    const p = g.players.get(id)!;
    p.role = roles[i];
  });
  // DM each their role. Mafia also learn their teammates so they can coordinate.
  const mafiaTeam = [...g.players.values()].filter((p) => p.role === 'mafia');
  for (const p of g.players.values()) {
    let msg = `دورك في المافيا: ${ROLE_AR[p.role]}`;
    if (p.role === 'mafia' && mafiaTeam.length > 1) {
      const partners = mafiaTeam.filter((m) => m.id !== p.id).map((m) => m.name).join('، ');
      msg += `\n🤝 شركاؤك بالمافيا: ${partners}`;
    }
    await telegram.sendMessage(p.id, msg).catch(() => undefined);
  }
}

async function beginNight(telegram: BotContext['telegram'], g: Game): Promise<void> {
  g.phase = 'night';
  g.resolving = false;
  g.round++;
  g.night = {};
  if (g.timer) clearTimeout(g.timer);
  await telegram
    .sendMessage(g.chatId, `🌙 الليلة ${g.round}: الجميع نام. المافيا تختار ضحيتها...`)
    .catch(() => undefined);

  const others = alive(g).filter((p) => p.role !== 'mafia');
  for (const p of alive(g)) {
    if (p.role === 'mafia') {
      await telegram.sendMessage(p.id, '🔫 اختر ضحية:', targetKeyboard(others, 'kill')).catch(() => undefined);
    } else if (p.role === 'doctor') {
      await telegram.sendMessage(p.id, '💉 اختر من تنقذه:', targetKeyboard(alive(g), 'save')).catch(() => undefined);
    } else if (p.role === 'detective') {
      await telegram
        .sendMessage(p.id, '🕵️ اختر من تكشفه:', targetKeyboard(alive(g).filter((x) => x.id !== p.id), 'check'))
        .catch(() => undefined);
    }
  }
  g.timer = setTimeout(() => void resolveNight(telegram, g), NIGHT_MS);
  g.timer.unref?.();
}

async function maybeResolveNight(telegram: BotContext['telegram'], g: Game): Promise<void> {
  const hasDoctor = alive(g).some((p) => p.role === 'doctor');
  const hasDetective = alive(g).some((p) => p.role === 'detective');
  if (g.night.kill && (!hasDoctor || g.night.save) && (!hasDetective || g.night.check)) {
    await resolveNight(telegram, g);
  }
}

async function resolveNight(telegram: BotContext['telegram'], g: Game): Promise<void> {
  if (g.phase !== 'night' || g.resolving) return;
  g.resolving = true;
  if (g.timer) clearTimeout(g.timer);
  let deadName: string | null = null;
  if (g.night.kill && g.night.kill !== g.night.save) {
    const victim = g.players.get(g.night.kill);
    if (victim?.alive) {
      victim.alive = false;
      deadName = `${victim.name} (${ROLE_AR[victim.role]})`;
    }
  }
  await telegram
    .sendMessage(g.chatId, deadName ? `🌅 الصباح: قُتل ${deadName} الليلة!` : '🌅 الصباح: نجا الجميع الليلة!')
    .catch(() => undefined);

  const winner = checkWin(g);
  if (winner) return void endGame(telegram, g, winner);
  await beginDay(telegram, g);
}

async function beginDay(telegram: BotContext['telegram'], g: Game): Promise<void> {
  g.phase = 'day';
  g.resolving = false;
  g.votes = new Map();
  if (g.timer) clearTimeout(g.timer);
  await telegram
    .sendMessage(
      g.chatId,
      '☀️ النهار: ناقشوا من المشتبه به، ثم صوّتوا لطرده 👇',
      targetKeyboard(alive(g), 'vote'),
    )
    .catch(() => undefined);
  g.timer = setTimeout(() => void resolveDay(telegram, g), DAY_MS);
  g.timer.unref?.();
}

async function resolveDay(telegram: BotContext['telegram'], g: Game): Promise<void> {
  if (g.phase !== 'day' || g.resolving) return;
  g.resolving = true;
  if (g.timer) clearTimeout(g.timer);
  const tally = new Map<number, number>();
  for (const target of g.votes.values()) tally.set(target, (tally.get(target) ?? 0) + 1);
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const tie = sorted.length > 1 && sorted[1][1] === top?.[1];

  if (!top || tie) {
    await telegram.sendMessage(g.chatId, '🤷 لم يتفق الجميع، لم يُطرد أحد اليوم.').catch(() => undefined);
  } else {
    const lynched = g.players.get(top[0]);
    if (lynched?.alive) {
      lynched.alive = false;
      await telegram
        .sendMessage(g.chatId, `⚖️ تم طرد ${lynched.name}! دوره كان ${ROLE_AR[lynched.role]}.`)
        .catch(() => undefined);
    }
  }
  const winner = checkWin(g);
  if (winner) return void endGame(telegram, g, winner);
  await beginNight(telegram, g);
}

function checkWin(g: Game): 'mafia' | 'citizens' | null {
  const m = aliveMafia(g).length;
  const others = alive(g).length - m;
  if (m === 0) return 'citizens';
  if (m >= others) return 'mafia';
  return null;
}

async function endGame(telegram: BotContext['telegram'], g: Game, winner: 'mafia' | 'citizens'): Promise<void> {
  g.phase = 'ended';
  const reveal = [...g.players.values()].map((p) => `• ${p.name}: ${ROLE_AR[p.role]}`).join('\n');
  await telegram
    .sendMessage(
      g.chatId,
      `🏁 انتهت اللعبة! الفائز: ${winner === 'mafia' ? '🔫 المافيا' : '👥 المواطنون'}\n\nالأدوار:\n${reveal}`,
    )
    .catch(() => undefined);
  cleanup(g);
  log.info({ chatId: g.chatId, winner }, 'mafia game ended');
}

function cleanup(g: Game): void {
  if (g.timer) clearTimeout(g.timer);
  for (const id of g.players.keys()) playerGame.delete(id);
  games.delete(g.chatId);
}
