// telegram.js — action-плагин отправки сообщения через Telegram Bot API.
//
// Вызывается из actions/runner.js при триггере action.type === 'telegram'.
// Шаги:
//   1) читает telegram_bot_token из settings (расшифровка через db/crypto.decrypt).
//   2) берёт chat_id из config (обязательное поле).
//   3) POST https://api.telegram.org/bot<token>/sendMessage
//      с { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }.
//   4) таймаут 15с (AbortController), retry 1 раз на 5xx / сетевых ошибках.
//
// Текст сообщения формируется из полей message + classification:
//   <b>важное/обычное</b> <reason>
//   <b>From:</b> <from_addr>
//   <b>Subject:</b> <subject>
//   <i>snippet</i>
//
// Возвращает { ok: true, messageId } или { ok: false, error }.
// Не кидает наружу: runner ждёт объект результата.

import { db } from '../db/index.js';
import { decrypt } from '../db/crypto.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'action:telegram' });

const TIMEOUT_MS = 15_000;
const RETRY_ON_STATUS_GTE = 500;

const selectTokenStmt = db.prepare(
  "SELECT value_enc FROM settings WHERE key = 'telegram_bot_token'",
);

function getBotToken() {
  const row = selectTokenStmt.get();
  if (!row || !row.value_enc) return null;
  try {
    const v = decrypt(row.value_enc);
    return v && v.trim() ? v.trim() : null;
  } catch (err) {
    log.error({ err: err?.message || String(err) }, 'failed to decrypt telegram_bot_token');
    return null;
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function clip(s, max) {
  if (s == null) return '';
  const str = String(s);
  return str.length <= max ? str : str.slice(0, max) + '…';
}

/**
 * Сформировать HTML-текст сообщения для Telegram.
 * Экспортируется для тестов / переиспользования.
 */
export function formatTelegramText(message, classification) {
  const important = classification?.important === true;
  const header = important ? '<b>⚠ Важное письмо</b>' : '<b>Новое письмо</b>';
  const reason = classification?.reason;
  const summary = classification?.summary;
  const tags = Array.isArray(classification?.tags) ? classification.tags : [];

  const from = message?.from_addr ?? message?.from ?? '';
  const subject = message?.subject ?? '(без темы)';
  const snippet = message?.snippet ?? '';

  const lines = [header];
  if (reason) lines.push(`<i>${escapeHtml(clip(reason, 300))}</i>`);
  lines.push(`<b>From:</b> ${escapeHtml(clip(from, 200))}`);
  lines.push(`<b>Subject:</b> ${escapeHtml(clip(subject, 300))}`);
  if (tags.length) {
    const tagLine = tags.slice(0, 10).map((t) => `#${escapeHtml(String(t).replace(/\s+/g, '_'))}`).join(' ');
    lines.push(tagLine);
  }
  if (snippet) {
    lines.push('');
    lines.push(escapeHtml(clip(snippet, 800)));
  }
  if (summary && summary !== reason) {
    lines.push('');
    lines.push(`<i>${escapeHtml(clip(summary, 400))}</i>`);
  }
  return lines.join('\n');
}

async function postOnce(token, payload, signal) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body };
}

/**
 * Отправить уведомление о письме в Telegram-чат.
 * @param {{ chat_id: string|number }} config
 * @param {object} message — API-shape (id, subject, from_addr, snippet, …)
 * @param {object} classification — JSON-объект классификации (important/reason/tags/summary)
 * @returns {Promise<{ ok: true, messageId?: number } | { ok: false, error: string, status?: number }>}
 */
export async function sendTelegram(config, message, classification) {
  const chatId = config?.chat_id;
  if (chatId === undefined || chatId === null || chatId === '') {
    return { ok: false, error: 'telegram: chat_id is missing in action config' };
  }

  const token = getBotToken();
  if (!token) {
    return { ok: false, error: 'telegram: telegram_bot_token is not configured' };
  }

  const text = formatTelegramText(message, classification);
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(new Error('timeout')), TIMEOUT_MS);
    try {
      const { status, ok, body } = await postOnce(token, payload, ac.signal);
      clearTimeout(tid);
      if (ok && body?.ok) {
        const messageId = body?.result?.message_id;
        log.info(
          { chat_id: chatId, attempt, messageId, status },
          'telegram sendMessage ok',
        );
        return { ok: true, messageId };
      }
      // 5xx — ретраим один раз
      if (status >= RETRY_ON_STATUS_GTE && attempt === 0) {
        lastErr = `telegram api ${status}: ${body?.description || ''}`;
        log.warn({ chat_id: chatId, status, attempt }, 'telegram 5xx, retrying');
        continue;
      }
      const err = body?.description || `telegram api returned ${status}`;
      log.error(
        { chat_id: chatId, status, err, attempt },
        'telegram sendMessage failed',
      );
      return { ok: false, error: err, status };
    } catch (err) {
      clearTimeout(tid);
      lastErr = err?.message || String(err);
      // AbortError — таймаут, сеть — ретраим один раз
      if (attempt === 0) {
        log.warn({ chat_id: chatId, err: lastErr, attempt }, 'telegram network err, retrying');
        continue;
      }
      log.error({ chat_id: chatId, err: lastErr }, 'telegram sendMessage network error');
      return { ok: false, error: lastErr };
    }
  }
  return { ok: false, error: lastErr || 'telegram: unknown error' };
}

export default { sendTelegram, formatTelegramText };
