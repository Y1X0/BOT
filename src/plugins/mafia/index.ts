import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { requireRole } from '../../utils/permissions';
import { createLogger } from '../../core/logger';
import { escapeHtml } from '../../locales';

/** Escape a player name for use inside an HTML message. */
const esc = (s: string | undefined): string => escapeHtml(String(s ?? ''));

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
  phase: 'lobby' | 'night' | 'day' | 'defense' | 'ended';
  players: Map<number, Player>;
  round: number;
  night: { kill?: number; save?: number; check?: number };
  votes: Map<number, number>; // day: voterId → targetId
  voteMsgId?: number; // the single live vote board (edited as votes come in)
  donId?: number; // current mafia boss (شيخ المافيا) — only he kills
  accused?: number; // most-voted player, on trial in the defense phase
  finalVotes: Map<number, boolean>; // defense: voterId → lynch?
  timer?: NodeJS.Timeout;
  resolving?: boolean; // re-entrancy guard so a phase never resolves twice
}

const games = new Map<number, Game>();
const playerGame = new Map<number, number>(); // userId → chatId
const LOBBY_MIN = 4;
const NIGHT_MS = 60_000;
const DAY_MS = 60_000;
const DEFENSE_MS = 45_000;

const alive = (g: Game) => [...g.players.values()].filter((p) => p.alive);
const aliveMafia = (g: Game) => alive(g).filter((p) => p.role === 'mafia');

/** The current mafia boss: only he chooses the night kill. If the stored boss is
 *  gone, the next living mafia inherits the role (طلع شيخ المافيا → التالي دوره). */
function ensureDon(g: Game): Player | undefined {
  const mafias = aliveMafia(g);
  if (!mafias.length) return undefined;
  let don = g.donId ? g.players.get(g.donId) : undefined;
  if (!don || !don.alive || don.role !== 'mafia') {
    don = mafias[0];
    g.donId = don.id;
  }
  return don;
}

function targetKeyboard(players: Player[], action: string) {
  return Markup.inlineKeyboard(
    players.map((p) => [Markup.button.callback(p.name, `maf:${action}:${p.id}`)]),
  );
}

/** One tidy board, edited live: a line per player showing who they voted for. */
function renderVoteBoard(g: Game): string {
  const voters = alive(g);
  const lines = voters.map((p) => {
    const targetId = g.votes.get(p.id);
    const target = targetId ? g.players.get(targetId)?.name : null;
    return target ? `✅ ${p.name} ⟵ ${target}` : `▫️ ${p.name} ⟵ —`;
  });
  return `☀️ التصويت (${g.votes.size}/${voters.length})\nمين المشتبه فيه؟\n\n${lines.join('\n')}`;
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
        finalVotes: new Map(),
      };
      games.set(ctx.chat.id, g);
      await ctx.reply(
        '🔫 <b>لعبة المافيا!</b>\n\nاضغط «انضمام» للمشاركة (لازم تبدأ محادثة خاصة مع البوت أولاً).\nالمضيف يضغط «ابدأ» عند اكتمال اللاعبين.',
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
          `🔫 <b>لعبة المافيا!</b>  المنضمّون (${g.players.size}):\n${[...g.players.values()].map((p) => `• <b>${esc(p.name)}</b>`).join('\n')}`,
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

    // Night actions (from DM). One choice per role per night — locked once made.
    bot.action(/^maf:(kill|save|check):(\d+)$/, async (ctx) => {
      const action = ctx.match[1] as 'kill' | 'save' | 'check';
      const targetId = Number(ctx.match[2]);
      const chatId = ctx.from ? playerGame.get(ctx.from.id) : undefined;
      const g = chatId ? games.get(chatId) : undefined;
      if (!g || g.phase !== 'night' || !ctx.from) return void ctx.answerCbQuery().catch(() => undefined);
      const actor = g.players.get(ctx.from.id);
      if (!actor?.alive) return void ctx.answerCbQuery('لا يمكنك التصرف.').catch(() => undefined);
      const target = g.players.get(targetId);
      if (!target?.alive) return void ctx.answerCbQuery('اختر لاعباً حياً.').catch(() => undefined);

      if (action === 'kill') {
        if (actor.role !== 'mafia') return void ctx.answerCbQuery('ليس دورك.').catch(() => undefined);
        const don = ensureDon(g);
        // Only the boss kills; the rest wait their turn until he's gone.
        if (!don || actor.id !== don.id)
          return void ctx.answerCbQuery('🔫 شيخ المافيا فقط يغتال الليلة.', { show_alert: true }).catch(() => undefined);
        if (g.night.kill != null) {
          const prev = g.players.get(g.night.kill);
          return void ctx
            .answerCbQuery(`لا يجوز — اخترت ${prev?.name} مسبقاً. اغتيال واحد فقط بالجولة.`, { show_alert: true })
            .catch(() => undefined);
        }
        g.night.kill = targetId;
        await ctx.answerCbQuery(`تم اختيار الضحية: ${target.name} ✅`).catch(() => undefined);
      } else if (action === 'save') {
        if (actor.role !== 'doctor') return void ctx.answerCbQuery('ليس دورك.').catch(() => undefined);
        if (g.night.save != null) {
          const prev = g.players.get(g.night.save);
          return void ctx
            .answerCbQuery(`انت حميت ${prev?.name} — حماية واحد فقط بالجولة.`, { show_alert: true })
            .catch(() => undefined);
        }
        g.night.save = targetId;
        await ctx.answerCbQuery(`تحمي: ${target.name} ✅`).catch(() => undefined);
      } else {
        // detective — one reveal per night.
        if (actor.role !== 'detective') return void ctx.answerCbQuery('ليس دورك.').catch(() => undefined);
        if (g.night.check != null)
          return void ctx
            .answerCbQuery('🕵️ انت سألت عن حد هالجولة — استنى للجولة الي بعدها.', { show_alert: true })
            .catch(() => undefined);
        g.night.check = targetId;
        await ctx.answerCbQuery('تم ✅').catch(() => undefined);
        await ctx.reply(`🔍 <b>${esc(target.name)}</b>: ${target.role === 'mafia' ? 'مافيا 🔫' : 'بريء ✅'}`).catch(() => undefined);
      }
      await maybeResolveNight(ctx.telegram, g);
    });

    // Day vote (in group) — transparent: every vote is announced.
    bot.action(/^maf:vote:(\d+)$/, async (ctx) => {
      const g = games.get(ctx.chat!.id);
      if (!g || g.phase !== 'day' || !ctx.from) return void ctx.answerCbQuery().catch(() => undefined);
      const voter = g.players.get(ctx.from.id);
      if (!voter?.alive) return void ctx.answerCbQuery('غير المشاركين لا يصوّتون.').catch(() => undefined);
      const targetId = Number(ctx.match[1]);
      const target = g.players.get(targetId);
      if (!target?.alive) return void ctx.answerCbQuery('اختر لاعباً حياً.').catch(() => undefined);
      g.votes.set(ctx.from.id, targetId);
      await ctx.answerCbQuery(`صوّتت على ${target.name} ✅`).catch(() => undefined);
      // Update the one live board instead of spamming a message per vote.
      if (g.voteMsgId)
        await ctx.telegram
          .editMessageText(g.chatId, g.voteMsgId, undefined, renderVoteBoard(g), targetKeyboard(alive(g), 'vote'))
          .catch(() => undefined);
      if (g.votes.size >= alive(g).length) await tallyDay(ctx.telegram, g);
    });

    // Final verdict after the accused defends himself.
    bot.action(/^maf:final:(0|1)$/, async (ctx) => {
      const g = games.get(ctx.chat!.id);
      if (!g || g.phase !== 'defense' || !ctx.from) return void ctx.answerCbQuery().catch(() => undefined);
      const voter = g.players.get(ctx.from.id);
      if (!voter?.alive) return void ctx.answerCbQuery('غير المشاركين لا يصوّتون.').catch(() => undefined);
      if (ctx.from.id === g.accused) return void ctx.answerCbQuery('لا تصوّت على نفسك.').catch(() => undefined);
      g.finalVotes.set(ctx.from.id, ctx.match[1] === '1');
      await ctx.answerCbQuery('تم ✅').catch(() => undefined);
      const eligible = alive(g).filter((p) => p.id !== g.accused).length;
      if (g.finalVotes.size >= eligible) await resolveDefense(ctx.telegram, g);
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
  // The first mafia is the boss (شيخ المافيا) — only he kills.
  const mafiaTeam = [...g.players.values()].filter((p) => p.role === 'mafia');
  g.donId = mafiaTeam[0]?.id;
  // DM each their role. Mafia also learn their teammates + who the boss is.
  for (const p of g.players.values()) {
    let msg = `🎭 <b>دورك في المافيا:</b> ${ROLE_AR[p.role]}`;
    if (p.role === 'mafia') {
      const boss = g.players.get(g.donId!);
      const isBoss = p.id === g.donId;
      msg += isBoss
        ? '\n👑 <b>أنت شيخ المافيا</b> — أنت من يختار الضحية.'
        : `\n👑 شيخ المافيا: <b>${esc(boss?.name)}</b> (هو من يغتال).`;
      if (mafiaTeam.length > 1) {
        const partners = mafiaTeam.filter((m) => m.id !== p.id).map((m) => esc(m.name)).join('، ');
        msg += `\n🤝 شركاؤك بالمافيا: <b>${partners}</b>`;
      }
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
    .sendMessage(g.chatId, `🌙 <b>الليلة ${g.round}</b>\nالجميع نام… شيخ المافيا يختار ضحيته 🔪`)
    .catch(() => undefined);

  const don = ensureDon(g);
  const others = alive(g).filter((p) => p.role !== 'mafia');
  for (const p of alive(g)) {
    if (p.role === 'mafia') {
      if (don && p.id === don.id) {
        await telegram.sendMessage(p.id, '🔫 أنت شيخ المافيا — اختر ضحية (اختيار واحد فقط):', targetKeyboard(others, 'kill')).catch(() => undefined);
      } else {
        await telegram.sendMessage(p.id, `🔫 شيخ المافيا (<b>${esc(don?.name)}</b>) هو من يختار هذه الليلة. انتظر دورك.`).catch(() => undefined);
      }
    } else if (p.role === 'doctor') {
      await telegram.sendMessage(p.id, '💉 اختر من تنقذه (واحد فقط):', targetKeyboard(alive(g), 'save')).catch(() => undefined);
    } else if (p.role === 'detective') {
      await telegram
        .sendMessage(p.id, '🕵️ اختر من تكشفه (واحد فقط):', targetKeyboard(alive(g).filter((x) => x.id !== p.id), 'check'))
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
      deadName = `<b>${esc(victim.name)}</b> (${ROLE_AR[victim.role]})`;
    }
  }
  await telegram
    .sendMessage(g.chatId, deadName ? `🌅 <b>الصباح</b>\nقُتل ${deadName} الليلة! 🔪` : '🌅 <b>الصباح</b>\nنجا الجميع الليلة! 🕊')
    .catch(() => undefined);

  const winner = checkWin(g);
  if (winner) return void endGame(telegram, g, winner);
  await beginDay(telegram, g);
}

async function beginDay(telegram: BotContext['telegram'], g: Game): Promise<void> {
  g.phase = 'day';
  g.resolving = false;
  g.votes = new Map();
  g.voteMsgId = undefined;
  if (g.timer) clearTimeout(g.timer);
  await telegram.sendMessage(g.chatId, '☀️ <b>النهار</b>\nناقشوا مين المشتبه فيه، ثم صوّتوا 👇').catch(() => undefined);
  const sent = await telegram
    .sendMessage(g.chatId, renderVoteBoard(g), targetKeyboard(alive(g), 'vote'))
    .catch(() => undefined);
  g.voteMsgId = sent?.message_id;
  g.timer = setTimeout(() => void tallyDay(telegram, g), DAY_MS);
  g.timer.unref?.();
}

/** Count the day votes, show who voted for whom, then put the top suspect on
 *  trial (defense phase) — a tie or no votes means nobody is accused. */
async function tallyDay(telegram: BotContext['telegram'], g: Game): Promise<void> {
  if (g.phase !== 'day' || g.resolving) return;
  g.resolving = true;
  if (g.timer) clearTimeout(g.timer);

  const tally = new Map<number, number>();
  for (const targetId of g.votes.values()) tally.set(targetId, (tally.get(targetId) ?? 0) + 1);
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const tie = sorted.length > 1 && sorted[1][1] === top?.[1];

  if (!top || tie) {
    await telegram.sendMessage(g.chatId, '🤷 <b>تعادل أو لا أصوات</b> — لم يُطرد أحد اليوم.').catch(() => undefined);
    const winner = checkWin(g);
    if (winner) return void endGame(telegram, g, winner);
    return void beginNight(telegram, g);
  }
  await beginDefense(telegram, g, top[0], top[1]);
}

/** The most-voted player defends himself, then everyone else votes to lynch. */
async function beginDefense(telegram: BotContext['telegram'], g: Game, accusedId: number, voteCount: number): Promise<void> {
  g.phase = 'defense';
  g.resolving = false;
  g.accused = accusedId;
  g.finalVotes = new Map();
  if (g.timer) clearTimeout(g.timer);
  const acc = g.players.get(accusedId);
  await telegram
    .sendMessage(
      g.chatId,
      `🗣 <b>${esc(acc?.name)}</b> هو الأكثر اشتباهاً (${voteCount} أصوات).\n<b>${esc(acc?.name)}</b>، عندك ${DEFENSE_MS / 1000} ثانية تبرّر نفسك!\nثم صوّتوا: نطرده؟`,
      Markup.inlineKeyboard([
        [Markup.button.callback('⚖️ اطرده', 'maf:final:1'), Markup.button.callback('🕊 بريء', 'maf:final:0')],
      ]),
    )
    .catch(() => undefined);
  g.timer = setTimeout(() => void resolveDefense(telegram, g), DEFENSE_MS);
  g.timer.unref?.();
}

async function resolveDefense(telegram: BotContext['telegram'], g: Game): Promise<void> {
  if (g.phase !== 'defense' || g.resolving) return;
  g.resolving = true;
  if (g.timer) clearTimeout(g.timer);
  const yes = [...g.finalVotes.values()].filter(Boolean).length;
  const no = g.finalVotes.size - yes;
  const acc = g.accused ? g.players.get(g.accused) : undefined;
  g.accused = undefined;
  if (acc?.alive && yes > no) {
    acc.alive = false;
    await telegram
      .sendMessage(g.chatId, `⚖️ <b>${yes}</b> مع الطرد مقابل <b>${no}</b>.\nتم طرد <b>${esc(acc.name)}</b>! دوره كان ${ROLE_AR[acc.role]}.`)
      .catch(() => undefined);
  } else {
    await telegram
      .sendMessage(g.chatId, `🕊 <b>${yes}</b> مع الطرد مقابل <b>${no}</b>.\nنجا <b>${esc(acc?.name ?? 'المتهم')}</b> من الطرد.`)
      .catch(() => undefined);
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
  const reveal = [...g.players.values()].map((p) => `• <b>${esc(p.name)}</b>: ${ROLE_AR[p.role]}`).join('\n');
  await telegram
    .sendMessage(
      g.chatId,
      `🏁 <b>انتهت اللعبة!</b>\nالفائز: <b>${winner === 'mafia' ? '🔫 المافيا' : '👥 المواطنون'}</b>\n\n<b>الأدوار:</b>\n${reveal}`,
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
