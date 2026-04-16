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
import {
  compile as compileExpr,
  DEFAULT_ALLOWED_IDENTIFIERS,
} from './evaluator.js';
import { parseOutputParams } from '../llm/classifier.js';
import { sendTelegram } from './telegram.js';
import { sendWebhook } from './webhook.js';
import { forwardAction } from './forward.js';
import { browserAction } from './browser.js';

const log = logger.child({ module: 'actionsRunner' });

let registered = false;

// Дедупликация глобальных actions (prompt_id IS NULL) при мультипромтовой классификации.
// Ключ: message_id → Set<action_id>. Очищается после обработки всех промтов.
// TTL: 60с — на случай если pipeline не почистит.
const globalActionRuns = new Map();
const GLOBAL_RUNS_TTL_MS = 60_000;

function markGlobalRun(messageId, actionId) {
  if (!globalActionRuns.has(messageId)) {
    globalActionRuns.set(messageId, { ids: new Set(), ts: Date.now() });
  }
  globalActionRuns.get(messageId).ids.add(actionId);
}

function wasGlobalRun(messageId, actionId) {
  const entry = globalActionRuns.get(messageId);
  return entry ? entry.ids.has(actionId) : false;
}

// Периодическая очистка stale entries.
setInterval(() => {
  const now = Date.now();
  for (const [mid, entry] of globalActionRuns) {
    if (now - entry.ts > GLOBAL_RUNS_TTL_MS) globalActionRuns.delete(mid);
  }
}, GLOBAL_RUNS_TTL_MS);

// Выбираем: enabled=1 и (prompt_id IS NULL => глобальный action, применим к любому промту)
// или prompt_id совпадает с тем, по которому письмо было классифицировано.
//
// Порядок выполнения: priority DESC, id ASC.
// Соглашение: чем БОЛЬШЕ priority, тем РАНЬШЕ правило проверяется.
// UI drag-reorder: верхнее правило = наибольший priority (см. views/prompts.js).
const selectActionsStmt = db.prepare(
  `SELECT id, name, prompt_id, match_expr, type, config_enc, enabled, priority
     FROM actions
    WHERE enabled = 1
      AND (prompt_id IS NULL OR prompt_id = @prompt_id)
    ORDER BY priority DESC, id ASC`,
);
const selectPromptParamsStmt = db.prepare(
  'SELECT output_params, match_mode FROM prompts WHERE id = ?',
);
const selectPromptMatchModeStmt = db.prepare(
  'SELECT match_mode FROM prompts WHERE id = ?',
);
const insertActionRunStmt = db.prepare(
  `INSERT INTO action_runs (action_id, message_id, ok, error, tokens_used, cost, created_at)
   VALUES (@action_id, @message_id, @ok, @error, @tokens_used, @cost, @created_at)`,
);

/**
 * Пишет журнал запуска action. Никогда не кидает — любой fail логируется.
 */
function logActionRun({ actionId, messageId, ok, error, tokensUsed, cost }) {
  try {
    insertActionRunStmt.run({
      action_id: actionId,
      message_id: messageId ?? null,
      ok: ok ? 1 : 0,
      error: error == null ? null : String(error).slice(0, 500),
      tokens_used: Number.isFinite(tokensUsed) ? tokensUsed : null,
      cost: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    log.warn({ err: err?.message || String(err), action_id: actionId }, 'action_runs insert failed');
  }
}

/**
 * Кэш-наивная резолюция whitelist идентификаторов для конкретного action.
 * Приоритет:
 *   1. action.prompt_id задан и у промта есть output_params → union(defaults, keys)
 *   2. Передан promptArg с output_params → union(defaults, keys)
 *   3. Иначе — дефолты (important/reason/tags/summary).
 */
function resolveAllowedIdentifiers(action, promptArg) {
  const out = new Set(DEFAULT_ALLOWED_IDENTIFIERS);
  let paramsRaw = null;
  if (action.prompt_id != null) {
    const row = selectPromptParamsStmt.get(action.prompt_id);
    paramsRaw = row ? row.output_params : null;
  } else if (promptArg && promptArg.output_params != null) {
    paramsRaw = promptArg.output_params;
  }
  for (const p of parseOutputParams(paramsRaw)) {
    out.add(p.key);
  }
  return out;
}

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
 * @param {{ tokens?: number, cost?: number }} [llmUsage] — per-prompt tokens/cost из pipeline event
 * @returns {Promise<Array<{ action_id:number, type:string, matched:boolean, ok?:boolean, error?:string }>>}
 */
export async function runActionsForMessage(message, classification, prompt = null, llmUsage = {}) {
  const promptId = prompt?.id ?? message?.prompt_id ?? null;
  const rows = selectActionsStmt.all({ prompt_id: promptId });
  if (rows.length === 0) {
    log.debug({ message_id: message?.id, prompt_id: promptId }, 'no enabled actions');
    return [];
  }

  // Ф3.2 — режим выполнения правил.
  // 'all'   — все matched правила диспатчатся параллельно (поведение по умолчанию).
  // 'first' — правила перебираются последовательно в порядке priority DESC, id ASC;
  //           после ПЕРВОГО matched + успешного dispatch (ok=true) — break; остальные
  //           правила пропускаются. Если matched, но dispatch упал — продолжаем к
  //           следующему matched правилу (считаем «первое подходящее = первое, которое
  //           реально доставилось»). Альтернативная семантика — «первое matched
  //           независимо от ok» — может быть рассмотрена позже.
  let matchMode = 'all';
  if (promptId != null) {
    try {
      const prow = selectPromptMatchModeStmt.get(promptId);
      if (prow && (prow.match_mode === 'all' || prow.match_mode === 'first')) {
        matchMode = prow.match_mode;
      }
    } catch {
      matchMode = 'all';
    }
  } else if (prompt && (prompt.match_mode === 'all' || prompt.match_mode === 'first')) {
    matchMode = prompt.match_mode;
  }

  if (matchMode === 'first') {
    return runFirstMode(rows, message, classification, prompt, promptId, llmUsage);
  }

  const pending = [];
  const messageId = message?.id ?? null;
  for (const row of rows) {
    // Дедупликация глобальных actions (prompt_id IS NULL) при мультипромтовой
    // классификации: если этот глобальный action уже выполнен для данного
    // письма другим промтом — пропускаем.
    if (row.prompt_id == null && messageId != null && wasGlobalRun(messageId, row.id)) {
      log.debug(
        { action_id: row.id, message_id: messageId },
        'global action already dispatched for this message — skipping duplicate',
      );
      pending.push(
        Promise.resolve({ action_id: row.id, type: row.type, matched: false, skipped: 'dedup' }),
      );
      continue;
    }

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

    // Компилируем match_expr; пустая строка / парс-ошибка => not matched, логируем.
    // Whitelist идентификаторов берём из output_params привязанного промта (union с дефолтами).
    let matched;
    try {
      const allowed = resolveAllowedIdentifiers(row, prompt);
      const fn = compileExpr(row.match_expr, allowed);
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

    // Помечаем глобальный action как выполненный для этого письма.
    if (row.prompt_id == null && messageId != null) {
      markGlobalRun(messageId, row.id);
    }

    const enriched = { ...row, config };
    // Per-prompt tokens/cost из pipeline event.
    const tokensUsed = Number.isFinite(llmUsage.tokens) ? llmUsage.tokens : null;
    const costUsed = typeof llmUsage.cost === 'number' && Number.isFinite(llmUsage.cost) ? llmUsage.cost : null;
    pending.push(
      dispatchAction(enriched, message, classification).then(
        (res) => {
          const ok = !!res?.ok;
          const error = ok ? undefined : res?.error || 'unknown error';
          logActionRun({
            actionId: row.id,
            messageId: message?.id ?? null,
            ok,
            error,
            tokensUsed,
            cost: costUsed,
          });
          return {
            action_id: row.id,
            type: row.type,
            matched: true,
            ok,
            error,
            tokens_used: tokensUsed,
          };
        },
        (err) => {
          const error = err?.message || String(err);
          logActionRun({
            actionId: row.id,
            messageId: message?.id ?? null,
            ok: false,
            error,
            tokensUsed,
            cost: costUsed,
          });
          return {
            action_id: row.id,
            type: row.type,
            matched: true,
            ok: false,
            error,
            tokens_used: tokensUsed,
          };
        },
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
 * Последовательный режим (match_mode='first').
 * Перебираем actions в порядке priority DESC, id ASC; после первого matched+ok=true — break.
 * Остальные правила не появляются в результатах (ни matched, ни skipped) — по смыслу
 * они даже не были проверены. Если matched, но dispatch упал — продолжаем к следующему.
 */
async function runFirstMode(rows, message, classification, prompt, promptId, llmUsage = {}) {
  const results = [];
  const messageId = message?.id ?? null;
  let matchedCount = 0;
  let okCount = 0;
  for (const row of rows) {
    // Дедупликация глобальных actions при мультипромтовой классификации.
    if (row.prompt_id == null && messageId != null && wasGlobalRun(messageId, row.id)) {
      log.debug(
        { action_id: row.id, message_id: messageId },
        'global action already dispatched for this message — skipping duplicate (first-mode)',
      );
      results.push({ action_id: row.id, type: row.type, matched: false, skipped: 'dedup' });
      continue;
    }

    const config = decryptConfig(row);
    if (config === null) {
      results.push({
        action_id: row.id,
        type: row.type,
        matched: false,
        ok: false,
        error: 'config decrypt/parse failed',
      });
      continue;
    }

    let matched;
    try {
      const allowed = resolveAllowedIdentifiers(row, prompt);
      const fn = compileExpr(row.match_expr, allowed);
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
      results.push({
        action_id: row.id,
        type: row.type,
        matched: false,
        ok: false,
        error: `match_expr: ${err?.message || String(err)}`,
      });
      continue;
    }

    if (!matched) {
      log.debug(
        { action_id: row.id, type: row.type, match_expr: row.match_expr },
        'action did not match (first-mode)',
      );
      results.push({ action_id: row.id, type: row.type, matched: false });
      continue;
    }

    matchedCount += 1;

    // Помечаем глобальный action как выполненный для этого письма.
    if (row.prompt_id == null && messageId != null) {
      markGlobalRun(messageId, row.id);
    }

    const enriched = { ...row, config };
    // Per-prompt tokens/cost из pipeline event.
    const tokensUsed = Number.isFinite(llmUsage.tokens) ? llmUsage.tokens : null;
    const costUsed = typeof llmUsage.cost === 'number' && Number.isFinite(llmUsage.cost) ? llmUsage.cost : null;

    let dispatchRes;
    try {
      dispatchRes = await dispatchAction(enriched, message, classification);
    } catch (err) {
      dispatchRes = { ok: false, error: err?.message || String(err) };
    }
    const ok = !!dispatchRes?.ok;
    const error = ok ? undefined : dispatchRes?.error || 'unknown error';
    logActionRun({
      actionId: row.id,
      messageId: message?.id ?? null,
      ok,
      error,
      tokensUsed,
      cost: costUsed,
    });
    results.push({
      action_id: row.id,
      type: row.type,
      matched: true,
      ok,
      error,
      tokens_used: tokensUsed,
    });
    if (ok) {
      okCount += 1;
      // break на первом matched+ok.
      break;
    }
    // matched, но ok=false: продолжаем к следующему matched правилу.
  }

  log.info(
    {
      message_id: message?.id,
      prompt_id: promptId,
      total: rows.length,
      matched: matchedCount,
      ok: okCount,
      failed: matchedCount - okCount,
      match_mode: 'first',
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
    const { message, classification, prompt, tokens, cost } = payload;
    runActionsForMessage(message, classification, prompt, { tokens, cost }).catch((err) =>
      log.error(
        { err: err?.message || String(err), message_id: message?.id },
        'runActionsForMessage unhandled error',
      ),
    );
  });
  log.info('actions runner registered (message:classified → runActionsForMessage)');
}

export default { runActionsForMessage, registerActionsRunner, dispatchAction };
