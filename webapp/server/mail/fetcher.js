// fetcher.js — забор тела письма по UID и сохранение в таблицу `messages`.
//
// Работает поверх уже открытого ImapFlow клиента (с активным mailboxLock).
// Через client.fetchOne тянет source (RFC822) + envelope + flags, парсит
// source через mailparser.simpleParser и делает INSERT OR IGNORE в messages
// (дедуп по UNIQUE account_id+uid).
//
// Возвращает объект message (как из api/messages.js) или null если запись
// уже существовала (IGNORE), либо если fetchOne ничего не вернул.

import { simpleParser } from 'mailparser';

import { db } from '../db/index.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'fetcher' });

const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO messages
     (account_id, uid, message_id, subject, from_addr, to_addr, date,
      snippet, body_text, body_html, is_read, is_important, created_at)
   VALUES
     (@account_id, @uid, @message_id, @subject, @from_addr, @to_addr, @date,
      @snippet, @body_text, @body_html, @is_read, @is_important, @created_at)`,
);

const selectStmt = db.prepare(
  `SELECT id, account_id, uid, message_id, subject, from_addr, to_addr, date,
          snippet, body_text, body_html, is_read, is_important,
          classification_json, prompt_id, created_at
     FROM messages
    WHERE account_id = ? AND uid = ?`,
);

function bufferToString(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return String(v);
}

function addressListText(v) {
  if (!v) return null;
  // mailparser возвращает объект вида { value: [...], text: '...', html: '...' }.
  if (typeof v === 'object' && typeof v.text === 'string') return v.text;
  if (Array.isArray(v)) {
    return v
      .map((a) => (typeof a === 'string' ? a : a?.text || a?.address || ''))
      .filter(Boolean)
      .join(', ');
  }
  return String(v);
}

function makeSnippet(text, html) {
  const base = (text && String(text)) || '';
  if (base.trim().length > 0) {
    return base.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  // Фолбэк: если text пустой — возьмём html и стрипнем теги.
  if (html) {
    const stripped = String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return stripped.slice(0, 200);
  }
  return null;
}

function rowForApi(row) {
  if (!row) return null;
  let classification = null;
  if (row.classification_json) {
    try {
      classification = JSON.parse(row.classification_json);
    } catch {
      classification = null;
    }
  }
  const { classification_json, ...rest } = row;
  return { ...rest, classification };
}

/**
 * Забрать одно письмо по UID и сохранить в БД.
 * @param {import('imapflow').ImapFlow} client — уже открытый клиент с выбранным mailbox.
 * @param {number} accountId
 * @param {number} uid
 * @returns {Promise<object|null>} — сохранённая запись message или null если дубль/пусто.
 */
export async function fetchAndStore(client, accountId, uid) {
  // Забираем сообщение по UID (важно передать { uid: true } в query options).
  const msg = await client.fetchOne(
    String(uid),
    { uid: true, envelope: true, flags: true, source: true, internalDate: true },
    { uid: true },
  );
  if (!msg || !msg.source) {
    log.warn({ accountId, uid }, 'fetchOne returned empty source');
    return null;
  }

  let parsed;
  try {
    parsed = await simpleParser(msg.source);
  } catch (err) {
    log.error({ err: err?.message || String(err), accountId, uid }, 'mailparser failed');
    return null;
  }

  const text = bufferToString(parsed.text);
  const html = bufferToString(parsed.html);

  const dateMs = (() => {
    const d = parsed.date || msg.envelope?.date || msg.internalDate;
    if (!d) return null;
    const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
    return Number.isFinite(t) ? t : null;
  })();

  const payload = {
    account_id: accountId,
    uid,
    message_id: parsed.messageId || msg.envelope?.messageId || null,
    subject: parsed.subject || msg.envelope?.subject || null,
    from_addr: addressListText(parsed.from) || addressListText(msg.envelope?.from),
    to_addr: addressListText(parsed.to) || addressListText(msg.envelope?.to),
    date: dateMs,
    snippet: makeSnippet(text, html),
    body_text: text,
    body_html: html,
    is_read: Array.isArray(msg.flags) ? (msg.flags.includes('\\Seen') ? 1 : 0) : 0,
    is_important: 0,
    created_at: Math.floor(Date.now() / 1000),
  };

  const info = insertStmt.run(payload);
  if (info.changes === 0) {
    // Уже было — дубликат.
    log.debug({ accountId, uid }, 'message already stored (dedup)');
    return null;
  }
  const row = selectStmt.get(accountId, uid);
  return rowForApi(row);
}
