import type { Plugin } from '../core/plugin';
import { createGeneralPlugin } from './general';
import { infoPlugin } from './info';
import { adminPlugin } from './admin';
import { moderationPlugin } from './moderation';
import { welcomePlugin } from './welcome';
import { engagementPlugin } from './engagement';
import { gamesPlugin } from './games';
import { economyPlugin } from './economy';
import { repliesPlugin } from './replies';
import { analyticsPlugin } from './analytics';
import { extrasPlugin } from './extras';
import { funPlugin } from './fun';
import { notesPlugin } from './notes';
import { afkPlugin } from './afk';
import { toolsPlugin } from './tools';
import { aiPlugin } from './ai';

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
  generalPlugin,
  infoPlugin,
  adminPlugin,
  moderationPlugin,
  welcomePlugin,
  analyticsPlugin,
  extrasPlugin,
  funPlugin,
  toolsPlugin,
  notesPlugin, // passive: #hashtag recall, calls next()
  economyPlugin,
  engagementPlugin, // passive: XP, calls next()
  afkPlugin, // passive: AFK return/mention, calls next()
  gamesPlugin, // passive: game answers, calls next() when not consumed
  repliesPlugin, // passive: keyword replies (terminal)
  aiPlugin,
);
