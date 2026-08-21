import type { Telegraf } from 'telegraf';
import type { BotContext } from './context';
import { createLogger } from './logger';
import { captureError } from './sentry';

/**
 * A Plugin is a self-contained feature module (welcome, moderation, games...).
 * It registers its own commands/handlers on the shared bot instance.
 *
 * To add a new feature: create a folder under src/plugins, export a Plugin,
 * and add it to the array in src/plugins/index.ts. Nothing else is required.
 */
export interface Plugin {
  /** Unique machine name, e.g. "welcome". */
  name: string;
  /** Short human description shown in diagnostics. */
  description?: string;
  /** Register handlers/commands on the bot. Called once at startup. */
  register(bot: Telegraf<BotContext>): void | Promise<void>;
  /**
   * Optional list of commands this plugin exposes, for the /help menu
   * and Telegram's command list. `staffOnly` hides them from regular users.
   */
  commands?: Array<{
    command: string;
    description: string;
    staffOnly?: boolean;
  }>;
}

const log = createLogger('plugin-registry');

/**
 * Registers a list of plugins and returns the aggregated command list.
 * A failing plugin is logged and skipped rather than crashing the whole bot.
 */
export async function registerPlugins(
  bot: Telegraf<BotContext>,
  plugins: Plugin[],
): Promise<Plugin[]> {
  const loaded: Plugin[] = [];
  for (const plugin of plugins) {
    try {
      await plugin.register(bot);
      loaded.push(plugin);
      log.info({ plugin: plugin.name }, 'Plugin registered');
    } catch (err) {
      log.error({ plugin: plugin.name, err }, 'Failed to register plugin');
      captureError(err, { phase: 'plugin-register', plugin: plugin.name });
    }
  }
  return loaded;
}
