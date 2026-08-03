import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { displayName } from '../../utils/format';
import { SPY_WORDS, assignRoles } from './logic';

interface Lobby {
  hostId: number;
  players: Map<number, string>; // userId → display name
  started: boolean;
  word?: string;
  spyId?: number;
}
const lobbies = new Map<number, Lobby>(); // one per chat

const MIN_PLAYERS = 3;
const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

function lobbyKeyboard(started: boolean) {
  return started
    ? Markup.inlineKeyboard([
        [Markup.button.callback('🔍 شوف دورك', 'spy:role')],
        [Markup.button.callback('🗳️ كشف الجاسوس', 'spy:reveal')],
      ])
    : Markup.inlineKeyboard([
        [Markup.button.callback('🙋 انضمام', 'spy:join')],
        [Markup.button.callback('▶️ بدء اللعبة', 'spy:start'), Markup.button.callback('❌ إلغاء', 'spy:cancel')],
      ]);
}

function lobbyText(l: Lobby): string {
  const names = [...l.players.values()].map((n, i) => `${i + 1}. ${n}`).join('\n') || '—';
  return (
    '🕵️ لعبة الجاسوس\n\n' +
    'الكل يأخذ كلمة سرية إلا «الجاسوس»!\n' +
    'اطرحوا أسئلة على بعض واكتشفوا مين الجاسوس 🔍\n\n' +
    `👥 اللاعبون (${l.players.size}):\n${names}\n\n` +
    `اضغط «انضمام» للدخول، والمضيف يضغط «بدء» (${MIN_PLAYERS}+ لاعبين).`
  );
}

/** Spyfall-style hidden-role game. Roles are revealed privately via callback alerts. */
export const spyPlugin: Plugin = {
  name: 'spy',
  description: 'Spyfall-style hidden role party game',
  commands: [{ command: 'spy', description: '🕵️ لعبة الجاسوس (جماعية)' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('spy', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      if (lobbies.has(ctx.chat!.id)) return void ctx.reply('🕵️ في لعبة شغّالة بالفعل! أكملوها أو الغوها أولاً.');
      const lobby: Lobby = {
        hostId: ctx.from.id,
        players: new Map([[ctx.from.id, displayName(ctx.from)]]),
        started: false,
      };
      lobbies.set(ctx.chat!.id, lobby);
      await ctx.reply(lobbyText(lobby), lobbyKeyboard(false));
    });

    bot.action('spy:join', async (ctx) => {
      const l = lobbies.get(ctx.chat!.id);
      if (!l || l.started) return void ctx.answerCbQuery('لا توجد لعبة مفتوحة.').catch(() => undefined);
      if (l.players.has(ctx.from.id)) return void ctx.answerCbQuery('أنت منضم بالفعل ✅').catch(() => undefined);
      l.players.set(ctx.from.id, displayName(ctx.from));
      await ctx.answerCbQuery('انضممت! 🎉').catch(() => undefined);
      await ctx.editMessageText(lobbyText(l), lobbyKeyboard(false)).catch(() => undefined);
    });

    bot.action('spy:cancel', async (ctx) => {
      const l = lobbies.get(ctx.chat!.id);
      if (!l) return void ctx.answerCbQuery().catch(() => undefined);
      if (ctx.from.id !== l.hostId) return void ctx.answerCbQuery('المضيف فقط يقدر يلغي.', { show_alert: true }).catch(() => undefined);
      lobbies.delete(ctx.chat!.id);
      await ctx.answerCbQuery('أُلغيت اللعبة.').catch(() => undefined);
      await ctx.editMessageText('❌ أُلغيت لعبة الجاسوس.').catch(() => undefined);
    });

    bot.action('spy:start', async (ctx) => {
      const l = lobbies.get(ctx.chat!.id);
      if (!l || l.started) return void ctx.answerCbQuery().catch(() => undefined);
      if (ctx.from.id !== l.hostId) return void ctx.answerCbQuery('المضيف فقط يقدر يبدأ.', { show_alert: true }).catch(() => undefined);
      if (l.players.size < MIN_PLAYERS) {
        return void ctx.answerCbQuery(`لازم ${MIN_PLAYERS} لاعبين على الأقل.`, { show_alert: true }).catch(() => undefined);
      }
      const { spyId, word } = assignRoles([...l.players.keys()], SPY_WORDS, Math.random);
      l.started = true;
      l.spyId = spyId;
      l.word = word;
      await ctx.answerCbQuery('بدأت اللعبة! 🕵️').catch(() => undefined);
      await ctx
        .editMessageText(
          '🕵️ بدأت اللعبة!\n\n' +
            'كل لاعب يضغط «🔍 شوف دورك» ليعرف كلمته سراً.\n' +
            'اطرحوا أسئلة على بعض لكشف الجاسوس، وهو يحاول يخمّن الكلمة.\n\n' +
            'لما تجهزوا، المضيف يضغط «🗳️ كشف الجاسوس».',
          lobbyKeyboard(true),
        )
        .catch(() => undefined);
    });

    bot.action('spy:role', async (ctx) => {
      const l = lobbies.get(ctx.chat!.id);
      if (!l || !l.started) return void ctx.answerCbQuery('لا توجد لعبة جارية.').catch(() => undefined);
      if (!l.players.has(ctx.from.id)) {
        return void ctx.answerCbQuery('أنت لست في هذه اللعبة.', { show_alert: true }).catch(() => undefined);
      }
      const secret =
        ctx.from.id === l.spyId
          ? '🕵️ أنت الجاسوس!\nحاول تعرف الكلمة السرية بدون ما ينكشف أمرك.'
          : `🔑 الكلمة السرية:\n«${l.word}»\n\nاكتشفوا مين الجاسوس!`;
      await ctx.answerCbQuery(secret, { show_alert: true }).catch(() => undefined);
    });

    bot.action('spy:reveal', async (ctx) => {
      const l = lobbies.get(ctx.chat!.id);
      if (!l || !l.started) return void ctx.answerCbQuery().catch(() => undefined);
      if (ctx.from.id !== l.hostId) return void ctx.answerCbQuery('المضيف فقط يقدر يكشف.', { show_alert: true }).catch(() => undefined);
      const spyName = l.players.get(l.spyId!) ?? '؟';
      lobbies.delete(ctx.chat!.id);
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx
        .editMessageText(`🕵️ الجاسوس كان: ${spyName}\n🔑 الكلمة كانت: «${l.word}»\n\nشكراً للّعب! /spy لجولة جديدة.`)
        .catch(() => undefined);
    });
  },
};
