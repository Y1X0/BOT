import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../core/context';
import { env } from '../config/env';
import { logMessage } from '../services/logging.service';
import { displayName } from '../utils/format';

/** Classify a Telegram message into a logged type + file reference. */
function classify(msg: Record<string, unknown>): { type: string; text?: string; fileId?: string } {
  const cap = (msg.caption as string) ?? undefined;
  if (msg.text) return { type: 'text', text: msg.text as string };
  if (msg.photo) {
    const sizes = msg.photo as Array<{ file_id: string }>;
    return { type: 'photo', text: cap, fileId: sizes[sizes.length - 1]?.file_id };
  }
  if (msg.video) return { type: 'video', text: cap, fileId: (msg.video as { file_id: string }).file_id };
  if (msg.animation) return { type: 'animation', text: cap, fileId: (msg.animation as { file_id: string }).file_id };
  if (msg.audio) return { type: 'audio', text: cap, fileId: (msg.audio as { file_id: string }).file_id };
  if (msg.voice) return { type: 'voice', fileId: (msg.voice as { file_id: string }).file_id };
  if (msg.sticker) return { type: 'sticker', fileId: (msg.sticker as { file_id: string }).file_id };
  if (msg.document) return { type: 'document', text: cap, fileId: (msg.document as { file_id: string }).file_id };
  if (msg.location) return { type: 'location' };
  if (msg.contact) return { type: 'contact' };
  return { type: 'other' };
}

/**
 * Records message metadata for the owner dashboard (opt-in). Captures new and
 * edited group messages. Never blocks the pipeline. Only stores what Telegram
 * delivers to the bot — no access to anything the bot didn't receive.
 */
export const loggingMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (!env.MESSAGE_LOG_ENABLED) return next();
  const chat = ctx.chat;
  const from = ctx.from;
  const raw = (ctx.message ?? ctx.editedMessage) as Record<string, unknown> | undefined;

  if (raw && chat && from && (chat.type === 'group' || chat.type === 'supergroup')) {
    const info = ctx.editedMessage ? { type: 'edit', text: (raw.text as string) ?? (raw.caption as string) } : classify(raw);
    void logMessage({
      chatId: BigInt(chat.id),
      chatTitle: (chat as { title?: string }).title ?? null,
      userId: BigInt(from.id),
      userName: displayName(from),
      messageId: Number(raw.message_id),
      type: info.type,
      text: info.text ?? null,
      fileId: (info as { fileId?: string }).fileId ?? null,
    });
  }
  return next();
};
