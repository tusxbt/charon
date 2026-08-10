import { TELEGRAM_CHAT_ID } from '../config.js';

/**
 * Charon only ever talks to one chat. Telegram delivers messages and callback
 * queries from anyone who finds the bot, and the command surface rewrites live
 * strategy config (position size included) while the callback surface can
 * approve a real trade in confirm mode — so both entry points check this.
 *
 * Kept in its own module so commands.js and callbacks.js can share it without
 * importing each other.
 */
export function isAuthorizedChat(chatId) {
  if (chatId === undefined || chatId === null) return false;
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}
