// services/messages.js — общая бизнес-логика обновления флагов письма.
//
// Используется из:
//   * api/messages.js     — PATCH /api/messages/:id
//   * ws/hub.js           — handler входящих WS {type:'mark_read', id}
//
// Ответственность:
//   1. UPDATE messages в локальной БД (is_read / is_important).
//   2. Fire-and-forget IMAP-синк флага \Seen через accountManager.getWorker(account_id).setFlag.
//      Если воркер не активен (account_enabled=0, ещё не подключился, или письмо в другой
//      папке) — warn-лог, REST ответ не валится. IMAP-операция асинхронна.
//   3. Эмит 'message:updated' в mailEvents — WS hub сам делает broadcast.
//
// Контракт:
//   markFlags(id, { is_read?, is_important? }) ->
//     { ok: true, message } | { ok: false, error: 'not_found'|'no_changes' }
//   Ошибки IMAP НЕ делают ok:false — БД обновлена, флаг уйдёт когда воркер оживёт
//   (в будущем можно добавить outbox-таблицу). Сейчас логируем warn и продолжаем.

import { db } from '../db/index.js';
import { logger } from '../logger.js';
import { mailEvents } from '../mail/events.js';
import * as accountManager from '../mail/accountManager.js';

const log = logger.child({ module: 'services/messages' });

const LIST_COLUMNS =
  'id, account_id, uid, message_id, subject, from_addr, to_addr, date, snippet, ' +
  'is_read, is_important, classification_json, prompt_id, created_at';

function parseRow(row) {
  if (!row) return null;
  let classification = null;
  if (row.classification_json) {
    try {
      classification = JSON.parse(row.classification_json);
    } catch {
      classification = null;
    }
  }
  return { ...row, classification };
}

/**
 * Обновить флаги письма: локальная БД + fire-and-forget IMAP-синк + WS событие.
 *
 * @param {number} id — messages.id
 * @param {{ is_read?: 0|1, is_important?: 0|1 }} patch
 * @returns {{ ok: true, message: object, changed: {is_read?:0|1, is_important?:0|1} } |
 *           { ok: false, error: 'not_found'|'invalid_id' }}
 */
export function markFlags(id, patch) {
  if (!Number.isFinite(id)) return { ok: false, error: 'invalid_id' };

  const existing = db
    .prepare('SELECT id, account_id, uid, is_read, is_important FROM messages WHERE id = ?')
    .get(id);
  if (!existing) return { ok: false, error: 'not_found' };

  const sets = [];
  const values = { id };
  const changed = {};
  if (patch?.is_read !== undefined) {
    const v = patch.is_read ? 1 : 0;
    if (existing.is_read !== v) {
      sets.push('is_read = @is_read');
      values.is_read = v;
      changed.is_read = v;
    }
  }
  if (patch?.is_important !== undefined) {
    const v = patch.is_important ? 1 : 0;
    if (existing.is_important !== v) {
      sets.push('is_important = @is_important');
      values.is_important = v;
      changed.is_important = v;
    }
  }

  if (sets.length > 0) {
    db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }

  const row = db.prepare(`SELECT ${LIST_COLUMNS} FROM messages WHERE id = ?`).get(id);

  // Fire-and-forget IMAP-синк \Seen (только если is_read реально изменился).
  // Для is_important IMAP-эквивалента нет (\Flagged можно добавить отдельной задачей).
  if (changed.is_read !== undefined) {
    const worker = accountManager.getWorker(existing.account_id);
    if (!worker) {
      log.warn(
        { id, account_id: existing.account_id, uid: existing.uid, is_read: changed.is_read },
        'imap worker not active — \\Seen sync skipped (db updated)',
      );
    } else {
      // Не ждём: REST должен отвечать сразу.
      Promise.resolve()
        .then(() => worker.setFlag(existing.uid, '\\Seen', changed.is_read === 1))
        .then((res) => {
          if (!res?.ok) {
            log.warn(
              { id, account_id: existing.account_id, uid: existing.uid, error: res?.error },
              'imap \\Seen sync returned non-ok',
            );
          }
        })
        .catch((err) => {
          log.error(
            { err: err?.message || String(err), id, uid: existing.uid },
            'imap \\Seen sync threw',
          );
        });
    }
  }

  // Эмитим событие даже если ничего не поменялось локально — отправитель хочет
  // подтверждения (совместимо с прежним поведением WS mark_read / PATCH). Но
  // payload включает только реально изменившиеся поля, плюс id для идентификации.
  const eventPayload = { id, account_id: existing.account_id, source: 'local' };
  if (patch?.is_read !== undefined) eventPayload.is_read = patch.is_read ? 1 : 0;
  if (patch?.is_important !== undefined) eventPayload.is_important = patch.is_important ? 1 : 0;
  mailEvents.emit('message:updated', eventPayload);

  return { ok: true, message: parseRow(row), changed };
}

export default { markFlags };
