import type { Plugin } from '../core/plugin';
import { aliasesPlugin } from './aliases';
import { msgEditPlugin } from './msgedit';
import { usagePlugin } from './usage';
import { musicArchivePlugin } from './musicarchive';
import { createGeneralPlugin } from './general';
import { menuPlugin } from './menu';
import { infoPlugin } from './info';
import { ownerPlugin } from './owner';
import { adminPlugin } from './admin';
import { moderationPlugin } from './moderation';
import { protectionPlugin } from './protection';
import { welcomePlugin } from './welcome';
import { engagementPlugin } from './engagement';
import { gamesPlugin } from './games';
import { economyPlugin } from './economy';
import { repliesPlugin } from './replies';
import { analyticsPlugin } from './analytics';
import { extrasPlugin } from './extras';
import { decoratePlugin } from './decorate';
import { funPlugin } from './fun';
import { notesPlugin } from './notes';
import { afkPlugin } from './afk';
import { toolsPlugin } from './tools';
import { whisperPlugin } from './whisper';
import { musarahaPlugin } from './musaraha';
import { youtubePlugin } from './youtube';
import { downloaderPlugin } from './downloader';
import { voiceChatPlugin } from './voicechat';
import { musicPlugin } from './music';
import { islamicPlugin } from './islamic';
import { toolboxPlugin } from './toolbox';
import { managementPlugin } from './management';
import { botRolesPlugin } from './botroles';
import { moreGamesPlugin } from './moregames';
import { newGamesPlugin } from './newgames';
import { socialPlugin } from './social';
import { birthdayPlugin } from './birthday';
import { reportsPlugin } from './reports';
import { marriagePlugin } from './marriage';
import { reputationPlugin } from './reputation';
import { ticketsPlugin } from './tickets';
import { ranksPlugin } from './ranks';
import { giveawayPlugin } from './giveaway';
import { qotdPlugin } from './qotd';
import { decidePlugin } from './decide';
import { countdownPlugin } from './countdown';
import { soundcloudPlugin } from './soundcloud';
import { podcastPlugin } from './podcast';
import { stickerPlugin } from './sticker';
import { stickerPackPlugin } from './stickerpack';
import { utilitiesPlugin } from './utilities';
import { mediaToolsPlugin } from './mediatools';
import { progressionPlugin } from './progression';
import { scheduledPlugin } from './scheduled';
import { liveQuizPlugin } from './livequiz';
import { mafiaPlugin } from './mafia';
import { imageEditorPlugin } from './imageeditor';
import { aiPlugin } from './ai';
import { spyPlugin } from './spy';
import { pdfPlugin } from './pdf';
import { petPlugin } from './pet';
import { typeRacePlugin } from './typerace';
import { guessMediaPlugin } from './guessmedia';

/**
 * Ordered plugin registry. ORDER MATTERS for passive text listeners:
 *   engagement (records XP, always next())
 *     → games   (consumes game answers, else next())
 *       → replies (terminal keyword responder)
 *
 * To add a feature: implement a Plugin and insert it here.
 */
export const allPlugins: Plugin[] = [];

// general/help is built with a getter over the final list.
const generalPlugin = createGeneralPlugin(() => allPlugins);

allPlugins.push(
  // Edit wizard runs before aliases so, while an owner is mid-edit, their typed
  // content is captured verbatim (not rewritten to a command). Passive otherwise.
  msgEditPlugin,
  aliasesPlugin, // MUST be first: rewrites Arabic words → /commands
  pdfPlugin, // wizard: captures text/photos/docs while active (before games/stickers)
  generalPlugin,
  menuPlugin,
  infoPlugin,
  ownerPlugin,
  adminPlugin,
  moderationPlugin,
  botRolesPlugin, // custom in-bot ranks (admin/moderator/vip)
  protectionPlugin, // anti-raid: must run before welcome on new_chat_members
  welcomePlugin,
  voiceChatPlugin,
  musicPlugin,
  managementPlugin, // includes service-message cleanup (before analytics)
  analyticsPlugin,
  usagePlugin,
  musicArchivePlugin,
  islamicPlugin,
  toolboxPlugin,
  utilitiesPlugin,
  mediaToolsPlugin,
  moreGamesPlugin, // passive: word-chain, calls next()
  newGamesPlugin, // passive: emoji/flag/hangman answers, calls next()
  guessMediaPlugin, // passive: movie/song guesses, calls next()
  typeRacePlugin, // passive: typing-race answers, calls next()
  spyPlugin,
  petPlugin,
  socialPlugin,
  birthdayPlugin,
  reportsPlugin,
  marriagePlugin,
  reputationPlugin, // passive: thanks → rep, calls next()
  ticketsPlugin,
  ranksPlugin,
  giveawayPlugin,
  qotdPlugin,
  decidePlugin,
  countdownPlugin,
  liveQuizPlugin, // passive: live-quiz answers, calls next()
  mafiaPlugin,
  imageEditorPlugin,
  extrasPlugin,
  decoratePlugin,
  funPlugin,
  toolsPlugin,
  whisperPlugin,
  musarahaPlugin, // DM anonymous-message flow (after whisper)
  youtubePlugin,
  soundcloudPlugin,
  podcastPlugin,
  stickerPackPlugin, // pack creation/add — must run before sticker auto-convert
  stickerPlugin, // passive: photo → sticker
  downloaderPlugin, // passive: auto-download known video links, calls next()
  notesPlugin, // passive: #hashtag recall, calls next()
  economyPlugin,
  progressionPlugin,
  scheduledPlugin,
  engagementPlugin, // passive: XP, calls next()
  afkPlugin, // passive: AFK return/mention, calls next()
  gamesPlugin, // passive: game answers, calls next() when not consumed
  aiPlugin, // passive: reply on @mention/reply-to-bot (before terminal replies)
  repliesPlugin, // passive: keyword replies (terminal)
);
