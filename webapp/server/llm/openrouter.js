// openrouter.js — вызов OpenRouter Chat Completions (модель x-ai/grok-4-fast).
//
// Экспортирует:
//   * classify({ systemPrompt, userPrompt, model?, timeoutMs?, retry? })
//       — POST https://openrouter.ai/api/v1/chat/completions
//         с response_format: { type: 'json_object' }.
//       Возвращает распарсенный JSON из message.content + meta (usage, raw, duration_ms).
//   * getOpenRouterKey() — читает settings.openrouter_api_key и расшифровывает
//     через crypto.decrypt. Возвращает null если ключ не задан.
//
// Особенности:
//   * Использует встроенный fetch (Node 20+).
//   * Таймаут по умолчанию 30с, через AbortController.
//   * Ретрай 1 раз при 5xx (настраивается через retry в аргументах).
//   * Логирует usage.total_tokens через pino.
//   * Если ключ не задан — бросает Error('openrouter_key_missing').

import { db } from '../db/index.js';
import { decrypt } from '../db/crypto.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'openrouter' });

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'x-ai/grok-4-fast';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY = 1;

const selectSettingStmt = db.prepare('SELECT value_enc FROM settings WHERE key = ?');

/**
 * Получить расшифрованный ключ OpenRouter из таблицы settings.
 * @returns {string|null} — plain-text ключ или null если нет/пусто.
 */
export function getOpenRouterKey() {
  const row = selectSettingStmt.get('openrouter_api_key');
  if (!row || !row.value_enc) return null;
  try {
    const key = decrypt(row.value_enc);
    return key && key.trim() ? key : null;
  } catch (err) {
    log.error({ err: err?.message || String(err) }, 'failed to decrypt openrouter_api_key');
    return null;
  }
}

/**
 * Синхронно выбросить первый элемент из AsyncIterable-подобной утилиты sleep.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Один POST на OpenRouter без ретраев.
 * @returns {Promise<{ status: number, json: any, durationMs: number }>}
 */
async function callOnce({ apiKey, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'mail-helper',
      },
      body: JSON.stringify(body),
    });
    const durationMs = Date.now() - t0;
    let json = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { _rawText: text };
      }
    }
    return { status: res.status, json, durationMs };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Вызвать LLM с системным и пользовательским промтами.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {string} [opts.model]           — по умолчанию x-ai/grok-4-fast
 * @param {number} [opts.timeoutMs]       — по умолчанию 30_000
 * @param {number} [opts.retry]           — по умолчанию 1 (ретраем на 5xx)
 * @returns {Promise<{ result: object, usage: object|null, durationMs: number, raw: any }>}
 */
export async function classify({
  systemPrompt,
  userPrompt,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retry = DEFAULT_RETRY,
}) {
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error('classify: systemPrompt is required');
  }
  if (typeof userPrompt !== 'string' || !userPrompt.trim()) {
    throw new Error('classify: userPrompt is required');
  }

  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    const err = new Error('openrouter_key_missing');
    err.code = 'openrouter_key_missing';
    throw err;
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  };

  let attempt = 0;
  let lastErr = null;
  // attempt=0 — первичный, затем до `retry` повторов.
  while (attempt <= retry) {
    try {
      const { status, json, durationMs } = await callOnce({ apiKey, body, timeoutMs });

      if (status >= 500 && attempt < retry) {
        log.warn(
          { status, attempt, durationMs },
          'openrouter 5xx — retrying',
        );
        attempt += 1;
        await sleep(500);
        continue;
      }
      if (status < 200 || status >= 300) {
        const message =
          (json && (json.error?.message || json.message)) ||
          (json && json._rawText) ||
          `http_${status}`;
        const err = new Error(`OpenRouter error ${status}: ${message}`);
        err.status = status;
        err.responseBody = json;
        throw err;
      }

      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        const err = new Error('OpenRouter: empty message.content');
        err.responseBody = json;
        throw err;
      }

      let result;
      try {
        result = JSON.parse(content);
      } catch (parseErr) {
        const err = new Error(
          `OpenRouter: message.content is not valid JSON (${parseErr?.message || 'parse error'})`,
        );
        err.responseBody = json;
        err.rawContent = content;
        throw err;
      }

      const usage = json?.usage || null;
      log.info(
        {
          model,
          tokens: usage?.total_tokens ?? null,
          prompt_tokens: usage?.prompt_tokens ?? null,
          completion_tokens: usage?.completion_tokens ?? null,
          durationMs,
        },
        'openrouter classify ok',
      );

      return { result, usage, durationMs, raw: json };
    } catch (err) {
      // AbortError — это таймаут; не ретраим (таймаут консистентно означает «долго»).
      const isAbort = err?.name === 'AbortError';
      const isNetwork = err?.name === 'TypeError' || err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT';
      lastErr = err;
      if (!isAbort && isNetwork && attempt < retry) {
        log.warn(
          { err: err?.message || String(err), attempt },
          'openrouter network error — retrying',
        );
        attempt += 1;
        await sleep(500);
        continue;
      }
      // Не ретраим: либо 4xx (брошено выше), либо AbortError, либо уже исчерпан retry.
      if (isAbort) {
        const timeoutErr = new Error(`OpenRouter timeout (${timeoutMs}ms)`);
        timeoutErr.code = 'openrouter_timeout';
        throw timeoutErr;
      }
      throw err;
    }
  }
  // Если мы сюда попали — все попытки провалились (только при network-retry).
  throw lastErr || new Error('openrouter: unknown failure');
}
