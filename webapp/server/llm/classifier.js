// classifier.js — применение LLM-промта к одному письму.
//
// Экспортирует:
//   * buildUserPrompt(message) — формирует user-content из полей письма
//     (subject, from, to, body_text обрезается до 4000 символов).
//   * pickPromptForMessage() — выбирает активный промт: сначала enabled=1 + is_default=1,
//     иначе первый enabled=1, иначе просто первый is_default=1. Может вернуть null.
//   * classifyMessage(messageRow, { prompt?, persist? = true })
//       — гоняет письмо через openrouter.classify, возвращает
//         { ok, result|error, prompt_id, durationMs, tokens }.
//         По умолчанию обновляет messages: classification_json, is_important, prompt_id.
//         Если уже есть classification_json и не передан prompt явно — skip (idempotent)
//         и вернёт сохранённый результат.
//       — Если openrouter_api_key отсутствует — бросает Error('openrouter_key_missing').
//
// MVP: применяется ровно один активный промт (default). Мультипромт — будущая итерация.

import { db } from '../db/index.js';
import { logger } from '../logger.js';
import { classify, getOpenRouterKey } from './openrouter.js';

const log = logger.child({ module: 'classifier' });

const BODY_MAX = 4000;

const selectDefaultEnabled = db.prepare(
  'SELECT id, name, system_prompt, output_schema, is_default, enabled ' +
    'FROM prompts WHERE enabled = 1 AND is_default = 1 LIMIT 1',
);
const selectAnyEnabled = db.prepare(
  'SELECT id, name, system_prompt, output_schema, is_default, enabled ' +
    'FROM prompts WHERE enabled = 1 ORDER BY is_default DESC, id ASC LIMIT 1',
);
const selectAnyDefault = db.prepare(
  'SELECT id, name, system_prompt, output_schema, is_default, enabled ' +
    'FROM prompts WHERE is_default = 1 LIMIT 1',
);
const updateMessageStmt = db.prepare(
  `UPDATE messages
      SET classification_json = ?, is_important = ?, prompt_id = ?
    WHERE id = ?`,
);
const selectMessageStmt = db.prepare(
  `SELECT id, account_id, uid, message_id, subject, from_addr, to_addr, date,
          snippet, body_text, body_html, is_read, is_important,
          classification_json, prompt_id, created_at
     FROM messages WHERE id = ?`,
);

/**
 * Выбрать активный промт для классификации. Может вернуть null если ничего не найдено.
 */
export function pickPromptForMessage() {
  return (
    selectDefaultEnabled.get() || selectAnyEnabled.get() || selectAnyDefault.get() || null
  );
}

function clip(s, max) {
  if (s == null) return '';
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n…[truncated]';
}

/**
 * Собрать user-content из полей письма. Тело обрезается до BODY_MAX символов.
 * @param {object} message — строка из messages (API-shape).
 * @returns {string}
 */
export function buildUserPrompt(message) {
  const subject = message?.subject ?? '';
  const from = message?.from_addr ?? message?.from ?? '';
  const to = message?.to_addr ?? message?.to ?? '';
  const body = clip(message?.body_text ?? '', BODY_MAX);
  return [
    `Subject: ${subject}`,
    `From: ${from}`,
    `To: ${to}`,
    '',
    'Body:',
    body,
  ].join('\n');
}

/**
 * Классифицировать одно письмо.
 *
 * @param {object} messageRow — запись из messages (минимум: id, subject, from_addr, to_addr, body_text, classification_json?)
 * @param {object} [opts]
 * @param {object} [opts.prompt]   — конкретный промт (если null — pickPromptForMessage()).
 * @param {boolean} [opts.persist] — сохранять результат в БД (по умолчанию true).
 * @param {boolean} [opts.force]   — игнорировать existing classification_json (default false).
 * @returns {Promise<{ ok: boolean, result?: object, error?: string, prompt_id: number|null, durationMs: number, tokens: number|null }>}
 */
export async function classifyMessage(messageRow, opts = {}) {
  const { prompt: explicitPrompt = null, persist = true, force = false } = opts;

  if (!messageRow || !messageRow.id) {
    throw new Error('classifyMessage: messageRow.id is required');
  }

  // Идемпотентность: если у письма уже есть classification_json и явно не запрошена
  // пере-классификация с указанием промта — возвращаем сохранённый результат.
  if (!force && !explicitPrompt && messageRow.classification_json) {
    let cached = null;
    try {
      cached = JSON.parse(messageRow.classification_json);
    } catch {
      cached = null;
    }
    log.debug({ message_id: messageRow.id }, 'classification cached, skipping LLM');
    return {
      ok: !!cached && !cached.error,
      result: cached,
      prompt_id: messageRow.prompt_id ?? null,
      durationMs: 0,
      tokens: null,
      cached: true,
    };
  }

  const prompt = explicitPrompt || pickPromptForMessage();
  if (!prompt) {
    throw new Error('classifyMessage: no active prompt found');
  }

  const userPrompt = buildUserPrompt(messageRow);

  let result;
  let usage = null;
  let durationMs = 0;

  try {
    const out = await classify({
      systemPrompt: prompt.system_prompt,
      userPrompt,
    });
    result = out.result;
    usage = out.usage;
    durationMs = out.durationMs;
  } catch (err) {
    // Если ключ не задан — пробрасываем наверх (pipeline должен принять решение skip vs error).
    if (err && err.code === 'openrouter_key_missing') throw err;

    const errorPayload = {
      error: true,
      message: err?.message || String(err),
      code: err?.code || null,
      status: err?.status || null,
    };
    log.error(
      { err: errorPayload, message_id: messageRow.id, prompt_id: prompt.id },
      'LLM classification failed',
    );
    if (persist) {
      updateMessageStmt.run(JSON.stringify(errorPayload), 0, prompt.id, messageRow.id);
    }
    return {
      ok: false,
      error: errorPayload.message,
      result: errorPayload,
      prompt_id: prompt.id,
      durationMs: 0,
      tokens: null,
    };
  }

  // Парсинг в объект прошёл в openrouter.classify(). Дополнительно убеждаемся что это объект.
  if (!result || typeof result !== 'object') {
    const msg = 'LLM returned non-object JSON';
    log.error(
      { message_id: messageRow.id, prompt_id: prompt.id, raw: result },
      msg,
    );
    const errorPayload = { error: true, message: msg };
    if (persist) {
      updateMessageStmt.run(JSON.stringify(errorPayload), 0, prompt.id, messageRow.id);
    }
    return {
      ok: false,
      error: msg,
      result: errorPayload,
      prompt_id: prompt.id,
      durationMs,
      tokens: usage?.total_tokens ?? null,
    };
  }

  const isImportant = result.important === true ? 1 : 0;

  if (persist) {
    updateMessageStmt.run(JSON.stringify(result), isImportant, prompt.id, messageRow.id);
  }

  log.info(
    {
      message_id: messageRow.id,
      prompt_id: prompt.id,
      important: isImportant === 1,
      tokens: usage?.total_tokens ?? null,
      durationMs,
    },
    'message classified',
  );

  return {
    ok: true,
    result,
    prompt_id: prompt.id,
    durationMs,
    tokens: usage?.total_tokens ?? null,
  };
}

/**
 * Служебный геттер — свежая запись из messages (используется в pipeline для emit после UPDATE).
 */
export function getMessageById(id) {
  return selectMessageStmt.get(id) || null;
}

/**
 * Быстрая проверка, настроен ли LLM (ключ присутствует). Используется в pipeline
 * чтобы skip-нуть классификацию и не ломать прилёт письма.
 */
export function isLlmConfigured() {
  return getOpenRouterKey() !== null;
}
