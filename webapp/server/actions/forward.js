// forward.js — action-плагин пересылки письма через SMTP.
//
// Вызывается из actions/runner.js при триггере action.type === 'forward'.
// config: { to: string|string[], from_account_id?: number }
//
// Использует mail/smtp.js.forwardMessage — она по messageId достанет тело из БД,
// обернёт в "---------- Forwarded message ----------" блок и отправит через
// nodemailer с SMTP-настройками указанного аккаунта (по умолчанию — аккаунт письма).
//
// Возвращает { ok, messageId? | error }. Не кидает наружу.

import { logger } from '../logger.js';
import { forwardMessage } from '../mail/smtp.js';

const log = logger.child({ module: 'action:forward' });

/**
 * Выполнить пересылку письма.
 * @param {{ to: string|string[], from_account_id?: number }} config
 * @param {object} message — API-shape (нужны message.id и message.account_id)
 * @returns {Promise<{ ok: boolean, messageId?: string, error?: string }>}
 */
export async function forwardAction(config, message) {
  const to = config?.to;
  if (!to || (Array.isArray(to) && to.length === 0)) {
    return { ok: false, error: 'forward: config.to is required' };
  }
  if (!message || !message.id) {
    return { ok: false, error: 'forward: message.id is required' };
  }

  const fromAccountId = Number.isFinite(config?.from_account_id)
    ? Number(config.from_account_id)
    : message.account_id;
  if (!fromAccountId) {
    return { ok: false, error: 'forward: no source account (config.from_account_id or message.account_id)' };
  }

  try {
    const info = await forwardMessage(fromAccountId, message.id, to);
    log.info(
      { to, from_account_id: fromAccountId, message_id: message.id, smtp_message_id: info?.messageId },
      'forward ok',
    );
    return { ok: true, messageId: info?.messageId };
  } catch (err) {
    const e = err?.message || String(err);
    log.error(
      { to, from_account_id: fromAccountId, message_id: message.id, err: e },
      'forward failed',
    );
    return { ok: false, error: e };
  }
}

export default { forwardAction };
