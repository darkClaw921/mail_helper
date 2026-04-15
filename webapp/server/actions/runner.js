// runner.js — диспетчер actions.
//
// Подписывается на mailEvents.'message:classified' (через registerActionsRunner())
// и для каждого события вызывает runActionsForMessage(). Сама регистрация
// идемпотентна (повторный вызов игнорируется).
//
// runActionsForMessage(message, classification, prompt?):
//   1) SELECT id, name, prompt_id, match_expr, type, config_enc, enabled
//      FROM actions
//      WHERE enabled = 1
//        AND (prompt_id IS NULL OR prompt_id = ?)
//   2) Для каждой строки:
//        * JSON.parse(decrypt(config_enc)) -> config
//        * compile(match_expr) и вызов evaluator с контекстом classification
//        * если truthy — dispatch по action.type в соответствующий модуль
//        * результат каждого action логируется (success/fail)
//        * ошибка одного action НЕ прерывает остальных
//   3) actions выполняются параллельно (Promise.allSettled).
//
// Экспорты:
//   * runActionsForMessage(message, classification, prompt?) -> Promise<results[]>
//   * registerActionsRunner() — подписка на mailEvents
//   * dispatchAction(action, message, classification) — внутренний хелпер (экспорт для тестов)

import { mailEvents } from '../mail/events.js';
import { db } from '../db/index.js';
import { decrypt } from '../db/crypto.js';
import { logger } from '../logger.js';
import { compile as compileExpr } from './evaluator.js';
import { sendTelegram } from './telegram.js';
import { sendWebhook } from './webhook.js';
import { forwardAction } from './forward.js';
import { browserAction } from './browser.js';

const log = logger.child({ module: 'actionsRunner' });

let registered = false;

// Выбираем: enabled=1 и (prompt_id IS NULL => глобальный action, применим к любому промту)
// или prompt_id совпадает с тем, по которому письмо было классифицировано.
const selectActionsStmt = db.prepare(
  `SELECT id, name, prompt_id, match_expr, type, config_enc, enabled
     FROM actions
    WHERE enabled = 1
      AND (prompt_id IS NULL OR prompt_id = @prompt_id)
    ORDER BY id`,
);

function decryptConfig(row) {
  if (!row.config_enc) return {};
  try {
    const raw = decrypt(row.config_enc);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    log.error(
      { action_id: row.id, err: err?.message || String(err) },
      'failed to decrypt/parse config_enc',
    );
    return null;
  }
}

/**
 * Диспатч одного уже распарсенного action.
 * Никогда не кидает — всегда возвращает { ok, ...info } для логов.
 */
export async function dispatchAction(action, message, classification) {
  const { id, type } = action;
  try {
    switch (type) {
      case 'telegram':
        return await sendTelegram(action.config, message, classification);
      case 'webhook':
        return await sendWebhook(action.config, message, classification);
      case 'forward':
        return await forwardAction(action.config, message);
      case 'browser':
        return await browserAction(action.config, message, classification);
      default:
        return { ok: false, error: `unknown action type '${type}'` };
    }
  } catch (err) {
    // Плагины сами ловят свои ошибки, но на всякий случай подстрахуемся.
    const e = err?.message || String(err);
    log.error({ action_id: id, type, err: e }, 'action threw unhandled error');
    return { ok: false, error: e };
  }
}

/**
 * Прогнать все matching actions для одного классифицированного письма.
 * @param {object} message — API-shape записи из messages
 * @param {object} classification — JSON-объект (important/reason/tags/summary)
 * @param {{ id?: number } | null} [prompt] — промт, по которому письмо классифицировали
 * @returns {Promise<Array<{ action_id:number, type:string, matched:boolean, ok?:boolean, error?:string }>>}
 */
export async function runActionsForMessage(message, classification, prompt = null) {
  const promptId = prompt?.id ?? message?.prompt_id ?? null;
  const rows = selectActionsStmt.all({ prompt_id: promptId });
  if (rows.length === 0) {
    log.debug({ message_id: message?.id, prompt_id: promptId }, 'no enabled actions');
    return [];
  }

  const pending = [];
  for (const row of rows) {
    const config = decryptConfig(row);
    if (config === null) {
      pending.push(
        Promise.resolve({
          action_id: row.id,
          type: row.type,
          matched: false,
          ok: false,
          error: 'config decrypt/parse failed',
        }),
      );
      continue;
    }

    // Компилируем match_expr; пустая строка / парс-ошибка => not matched, логируем
    let matched;
    try {
      const fn = compileExpr(row.match_expr);
      matched = fn(classification || {});
    } catch (err) {
      log.error(
        {
          action_id: row.id,
          type: row.type,
          match_expr: row.match_expr,
          err: err?.message || String(err),
        },
        'match_expr evaluation failed',
      );
      pending.push(
        Promise.resolve({
          action_id: row.id,
          type: row.type,
          matched: false,
          ok: false,
          error: `match_expr: ${err?.message || String(err)}`,
        }),
      );
      continue;
    }

    if (!matched) {
      log.debug(
        { action_id: row.id, type: row.type, match_expr: row.match_expr },
        'action did not match',
      );
      pending.push(
        Promise.resolve({ action_id: row.id, type: row.type, matched: false }),
      );
      continue;
    }

    const enriched = { ...row, config };
    pending.push(
      dispatchAction(enriched, message, classification).then(
        (res) => ({
          action_id: row.id,
          type: row.type,
          matched: true,
          ok: !!res?.ok,
          error: res?.ok ? undefined : res?.error || 'unknown error',
        }),
        // dispatchAction сам не должен кидать, но на всякий случай
        (err) => ({
          action_id: row.id,
          type: row.type,
          matched: true,
          ok: false,
          error: err?.message || String(err),
        }),
      ),
    );
  }

  const settled = await Promise.allSettled(pending);
  const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : {
    action_id: null,
    type: null,
    matched: false,
    ok: false,
    error: s.reason?.message || String(s.reason),
  }));

  // Сводный лог
  const matchedCount = results.filter((r) => r.matched).length;
  const okCount = results.filter((r) => r.matched && r.ok).length;
  log.info(
    {
      message_id: message?.id,
      prompt_id: promptId,
      total: rows.length,
      matched: matchedCount,
      ok: okCount,
      failed: matchedCount - okCount,
    },
    'actions run complete',
  );

  return results;
}

/**
 * Подписать runner на mailEvents.'message:classified'. Идемпотентно.
 * Вызывается один раз при старте сервера из index.js.
 */
export function registerActionsRunner() {
  if (registered) return;
  registered = true;
  mailEvents.on('message:classified', (payload) => {
    if (!payload) return;
    const { message, classification, prompt } = payload;
    runActionsForMessage(message, classification, prompt).catch((err) =>
      log.error(
        { err: err?.message || String(err), message_id: message?.id },
        'runActionsForMessage unhandled error',
      ),
    );
  });
  log.info('actions runner registered (message:classified → runActionsForMessage)');
}

export default { runActionsForMessage, registerActionsRunner, dispatchAction };
