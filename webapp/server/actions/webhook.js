// webhook.js — action-плагин отправки JSON POST на произвольный URL.
//
// Вызывается из actions/runner.js при триггере action.type === 'webhook'.
// config: { url: string, headers?: { [k]: string } }
//
// Поведение:
//   * POST на config.url с Content-Type: application/json.
//   * Body: { message: { id, account_id, subject, from_addr, to_addr, date, snippet },
//            classification }.
//   * Опциональные headers из config мёржатся поверх дефолтных (нельзя перетереть Content-Type).
//   * Таймаут 15с.
//   * Retry 1 раз на 5xx или network/AbortError.
//   * Статус <400 считается успехом.
//
// Возвращает { ok, status, error? } — никогда не кидает.

import { logger } from '../logger.js';
import { renderTemplate } from './template.js';

const log = logger.child({ module: 'action:webhook' });

const TIMEOUT_MS = 15_000;

function buildPayload(message, classification, template) {
  const m = message || {};
  const payload = {
    message: {
      id: m.id ?? null,
      account_id: m.account_id ?? null,
      uid: m.uid ?? null,
      message_id: m.message_id ?? null,
      subject: m.subject ?? null,
      from_addr: m.from_addr ?? null,
      to_addr: m.to_addr ?? null,
      date: m.date ?? null,
      snippet: m.snippet ?? null,
      is_important: m.is_important ?? null,
    },
    classification: classification ?? null,
  };
  // Если задан шаблон — рендерим его и кладём как поле text в payload.
  // Без экранирования (webhook принимает произвольный JSON-текст).
  const tpl = typeof template === 'string' ? template.trim() : '';
  if (tpl) {
    payload.text = renderTemplate(tpl, { message, classification });
  }
  return payload;
}

function buildHeaders(customHeaders) {
  const base = { 'content-type': 'application/json', accept: 'application/json' };
  if (!customHeaders || typeof customHeaders !== 'object') return base;
  const result = { ...base };
  for (const [k, v] of Object.entries(customHeaders)) {
    if (typeof k !== 'string') continue;
    if (v == null) continue;
    // Не разрешаем перетирать content-type из соображений согласованности payload
    if (k.toLowerCase() === 'content-type') continue;
    result[k] = String(v);
  }
  return result;
}

async function postOnce(url, headers, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal,
  });
  let respText = null;
  try {
    respText = await res.text();
  } catch {
    respText = null;
  }
  return { status: res.status, ok: res.ok, respText };
}

/**
 * Отправить webhook.
 * @param {{ url: string, headers?: object }} config
 * @param {object} message — API-shape
 * @param {object} classification
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function sendWebhook(config, message, classification) {
  const url = config?.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'webhook: config.url must be a http(s) URL' };
  }
  const headers = buildHeaders(config?.headers);
  const body = JSON.stringify(buildPayload(message, classification, config?.template));

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(new Error('timeout')), TIMEOUT_MS);
    try {
      const { status, ok } = await postOnce(url, headers, body, ac.signal);
      clearTimeout(tid);
      if (ok) {
        log.info({ url, status, attempt }, 'webhook ok');
        return { ok: true, status };
      }
      if (status >= 500 && attempt === 0) {
        lastErr = `webhook ${status}`;
        log.warn({ url, status, attempt }, 'webhook 5xx, retrying');
        continue;
      }
      log.error({ url, status, attempt }, 'webhook failed');
      return { ok: false, status, error: `webhook returned ${status}` };
    } catch (err) {
      clearTimeout(tid);
      lastErr = err?.message || String(err);
      if (attempt === 0) {
        log.warn({ url, err: lastErr, attempt }, 'webhook network err, retrying');
        continue;
      }
      log.error({ url, err: lastErr }, 'webhook network error');
      return { ok: false, error: lastErr };
    }
  }
  return { ok: false, error: lastErr || 'webhook: unknown error' };
}

export default { sendWebhook };
