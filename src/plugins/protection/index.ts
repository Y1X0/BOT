import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { prisma } from '../../core/database';
import { requireRole, isBotOwner } from '../../utils/permissions';
import { setBoolean, type ToggleableSetting } from '../../services/settings.service';
import { muteUser } from '../../utils/moderation-actions';
import { createLogger } from '../../core/logger';
import { makeRaidState, recordJoin, type RaidState } from './raid';

const log = createLogger('plugin:protection');

// Tuning: 5+ joins within 10s triggers a 60s lockdown window.
const THRESHOLD = 5;
const WINDOW_MS = 10_000;
const COOLDOWN_MS = 60_000;

// Guardian mode: the full protection suite toggled together.
const GUARD_ON = {
  antispamEnabled: true,
  floodEnabled: true,
  antiLinkEnabled: true,
  antiForwardEnabled: true,
  filtersEnabled: true,
  badwordsEnabled: true,
  antiRaidEnabled: true,
  cleanServiceEnabled: true,
} as const;
// Turn off the strict extras but keep baseline anti-spam/flood/filters on.
const GUARD_OFF = {
  antiLinkEnabled: false,
  antiForwardEnabled: false,
  badwordsEnabled: false,
  antiRaidEnabled: false,
  cleanServiceEnabled: false,
} as const;

const raidStates = new Map<number, RaidState>();
function stateFor(chatId: number): RaidState {
  let s = raidStates.get(chatId);
  if (!s) {
    s = makeRaidState();
    raidStates.set(chatId, s);
  }
  return s;
}

const FULL_PERMS = {
  can_send_messages: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
};

/**
 * Group protection: anti-raid (mass-join detection → auto-lock + mute the
 * burst) plus manual /lockdown and /unlock. Uses only Telegram Bot API
 * moderation calls. Anti-raid is opt-in per chat (antiRaidEnabled).
 */
export const protectionPlugin: Plugin = {
  name: 'protection',
  description: 'Anti-raid mass-join detection and group lockdown',
  commands: [
    { command: 'lockdown', description: '🔒 قفل الكتابة في الجروب', staffOnly: true },
    { command: 'unlock', description: '🔓 فتح الكتابة في الجروب', staffOnly: true },
    { command: 'antiraid', description: '🛡 تفعيل/إيقاف مكافحة الغارات', staffOnly: true },
    { command: 'guard', description: '🛡 وضع الحارس: تفعيل كل الحمايات دفعة', staffOnly: true },
    { command: 'guardall', description: '🛡 تطبيق الحارس على كل القروبات (المالك)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // --- Anti-raid on mass join (runs before welcome) ---
    bot.on('new_chat_members', async (ctx, next) => {
      if (!ctx.chat || !ctx.state.settings?.antiRaidEnabled) return next();
      const chatId = ctx.chat.id;
      const state = stateFor(chatId);
      const now = Date.now();

      let raiding = false;
      let triggered = false;
      for (const m of ctx.message.new_chat_members) {
        if (m.is_bot) continue;
        const r = recordJoin(state, now, THRESHOLD, WINDOW_MS, COOLDOWN_MS);
        if (r.raid) {
          raiding = true;
          await muteUser(ctx, m.id); // silence the raider; admin decides ban
        }
        if (r.justTriggered) triggered = true;
      }

      if (triggered) {
        await ctx.telegram.setChatPermissions(chatId, { can_send_messages: false }).catch(() => undefined);
        await ctx.reply('🚨 تم رصد غارة (دخول جماعي مفاجئ)!\n🔒 تم قفل الجروب وكتم الأعضاء الجدد.\nراجعوا القائمة ثم استخدموا /unlock للفتح.').catch(() => undefined);
        log.warn({ chatId }, 'raid detected — group locked');
      }

      if (raiding) return; // suppress welcome/other join handlers during a raid
      return next();
    });

    // --- Manual lockdown / unlock ---
    bot.command('lockdown', requireRole('manager'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const ok = await ctx.telegram.setChatPermissions(ctx.chat.id, { can_send_messages: false }).then(() => true).catch(() => false);
      await ctx.reply(ok ? '🔒 تم قفل الجروب — لا يمكن الكتابة الآن.' : '❌ تعذّر القفل (تأكد أن البوت مشرف).');
    });

    bot.command('unlock', requireRole('manager'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const ok = await ctx.telegram.setChatPermissions(ctx.chat.id, FULL_PERMS).then(() => true).catch(() => false);
      if (ok) raidStates.delete(ctx.chat.id); // clear any active raid window
      await ctx.reply(ok ? '🔓 تم فتح الجروب — يمكن الكتابة الآن.' : '❌ تعذّر الفتح (تأكد أن البوت مشرف).');
    });

    // --- Toggle anti-raid ---
    bot.command('antiraid', requireRole('manager'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      const off = arg === 'off' || arg === 'ايقاف' || arg === 'إيقاف';
      // No arg → flip the current state (smart toggle).
      const cur = !!ctx.state.settings?.antiRaidEnabled;
      const on = arg === 'on' || arg === 'تفعيل' ? true : off ? false : !cur;
      await prisma.chatSettings.update({ where: { chatId: BigInt(ctx.chat.id) }, data: { antiRaidEnabled: on } });
      await ctx.reply(on ? '🛡 تم تفعيل مكافحة الغارات — سيتم قفل الجروب تلقائياً عند دخول جماعي مفاجئ.' : '🛡 تم إيقاف مكافحة الغارات.');
    });

    // --- Guardian mode: flip the whole protection suite at once ---
    bot.command('guard', requireRole('manager'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      const on = arg === 'on' || arg === 'تفعيل' || arg === 'فعل';
      const off = arg === 'off' || arg === 'ايقاف' || arg === 'إيقاف' || arg === 'وقف';
      if (!on && !off) {
        return void ctx.reply(
          '🛡 وضع الحارس يفعّل كل الحمايات دفعة واحدة:\n' +
            'مكافحة السبام والتكرار، منع الروابط والتوجيه، فلتر الكلمات، منع السب، مكافحة الغارات، وتنظيف رسائل الخدمة.\n\n' +
            'استخدم: /guard on   أو   /guard off',
        );
      }
      await prisma.chatSettings.update({ where: { chatId: BigInt(ctx.chat.id) }, data: on ? GUARD_ON : GUARD_OFF });
      await ctx.reply(
        on
          ? '🛡 تم تفعيل وضع الحارس — الجروب محمي بالكامل الآن:\n✅ سبام · ✅ تكرار · ✅ روابط · ✅ توجيه · ✅ كلمات ممنوعة · ✅ منع سب · ✅ غارات · ✅ تنظيف'
          : '🛡 تم إيقاف الحمايات الإضافية لوضع الحارس (تبقى مكافحة السبام الأساسية).',
      );
    });

    // --- Apply guardian mode to ALL groups at once (bot owner only) ---
    bot.command('guardall', async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      const on = arg === 'on' || arg === 'تفعيل';
      const off = arg === 'off' || arg === 'ايقاف' || arg === 'إيقاف';
      if (!on && !off) {
        return void ctx.reply('🛡 يطبّق وضع الحارس على كل القروبات.\nاستخدم: /guardall on   أو   /guardall off');
      }
      const res = await prisma.chatSettings.updateMany({ data: on ? GUARD_ON : GUARD_OFF });
      log.info({ count: res.count, on }, 'guardall applied');
      await ctx.reply(`🛡 تم ${on ? 'تفعيل' : 'إيقاف'} وضع الحارس على ${res.count} قروب.`);
    });

    // --- Quick Arabic protection toggles (admin+): «منع سب» يفعّل، «فتح سب» يوقف.
    // Works for: سب/سبام/تكرار/روابط/توجيه/كلمات/غارات — and «الكل» = وضع الحارس. ---
    bot.hears(QUICK_RE, async (ctx, next) => {
      if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) return next();
      const verb = ctx.match[1];
      const word = ctx.match[2];
      const target = QUICK_TARGETS[word];
      const isAll = ALL_WORDS.has(word);
      if (!target && !isAll) return next(); // a known verb but not a protection word
      if (!ctx.state.isStaff) return next(); // silently ignore for non-staff
      const enable = BLOCK_VERBS.has(verb);

      if (isAll) {
        await prisma.chatSettings
          .update({ where: { chatId: BigInt(ctx.chat.id) }, data: enable ? GUARD_ON : GUARD_OFF })
          .catch(() => undefined);
        await ctx.reply(enable ? '🛡 تم تفعيل <b>كل الحمايات</b> (وضع الحارس).' : '⚠️ تم إيقاف الحمايات الإضافية.');
        return;
      }
      await setBoolean(ctx.chat.id, target!.key, enable).catch(() => undefined);
      await ctx.reply(`${enable ? '🛡 تم تفعيل' : '⚠️ تم إيقاف'} <b>${target!.name}</b>.`);
    });
  },
};

// Quick-toggle vocabulary. منع/تفعيل/شغل/حظر/مكافحة → ON, فتح/ايقاف/وقف → OFF.
const BLOCK_VERBS = new Set(['منع', 'امنع', 'تفعيل', 'فعل', 'فعّل', 'شغل', 'تشغيل', 'حظر', 'مكافحة', 'مكافحه']);
const ALLOW_VERBS = new Set(['فتح', 'افتح', 'ايقاف', 'إيقاف', 'وقف', 'اوقف', 'اطفي', 'اطفئ', 'اطفاء', 'الغاء', 'إلغاء', 'سماح', 'اسمح']);
const QUICK_RE = new RegExp(`^(${[...BLOCK_VERBS, ...ALLOW_VERBS].join('|')})\\s+(\\S+)$`);
const ALL_WORDS = new Set(['الكل', 'كلشي', 'كلشيء', 'الحمايات', 'الحمايه', 'الحماية', 'حمايه', 'حماية']);
const QUICK_TARGETS: Record<string, { key: ToggleableSetting; name: string }> = {
  سب: { key: 'badwordsEnabled', name: 'منع السب' },
  السب: { key: 'badwordsEnabled', name: 'منع السب' },
  شتم: { key: 'badwordsEnabled', name: 'منع السب' },
  الشتم: { key: 'badwordsEnabled', name: 'منع السب' },
  سبام: { key: 'antispamEnabled', name: 'مكافحة السبام' },
  السبام: { key: 'antispamEnabled', name: 'مكافحة السبام' },
  تكرار: { key: 'floodEnabled', name: 'منع التكرار' },
  التكرار: { key: 'floodEnabled', name: 'منع التكرار' },
  روابط: { key: 'antiLinkEnabled', name: 'منع الروابط' },
  الروابط: { key: 'antiLinkEnabled', name: 'منع الروابط' },
  رابط: { key: 'antiLinkEnabled', name: 'منع الروابط' },
  توجيه: { key: 'antiForwardEnabled', name: 'منع التوجيه' },
  التوجيه: { key: 'antiForwardEnabled', name: 'منع التوجيه' },
  كلمات: { key: 'filtersEnabled', name: 'فلتر الكلمات' },
  الكلمات: { key: 'filtersEnabled', name: 'فلتر الكلمات' },
  غارات: { key: 'antiRaidEnabled', name: 'مكافحة الغارات' },
  الغارات: { key: 'antiRaidEnabled', name: 'مكافحة الغارات' },
};
