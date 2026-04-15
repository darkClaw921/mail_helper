// pipeline.js — подписка на mailEvents.'message:stored' и запуск LLM-классификации.
//
// Экспортирует registerClassifierPipeline() — вызывается один раз при старте сервера.
// Поведение:
//   * На каждое событие mailEvents.emit('message:stored', { message }) запускает
//     асинхронно classifyMessage(message). Ошибки не валят pipeline, только логируются.
//   * Если openrouter_api_key не задан — skip с warn.
//   * Если уже есть classification_json — classifyMessage вернёт cached и мы всё равно
//     эмитим 'message:classified' (для WS hub / actions runner).
//   * После успешной классификации загружает свежую запись из БД и эмитит
//     mailEvents.emit('message:classified', { message, classification, prompt }).
//
// Идемпотентность:
//   Сам registerClassifierPipeline() — один раз за процесс; повторный вызов игнорируется.

import { mailEvents } from '../mail/events.js';
import { logger } from '../logger.js';
import { db } from '../db/index.js';
import {
  classifyMessage,
  getMessageById,
  isLlmConfigured,
  pickPromptForMessage,
} from './classifier.js';

const log = logger.child({ module: 'llmPipeline' });

let registered = false;

const selectPromptStmt = db.prepare(
  'SELECT id, name, system_prompt, output_schema, is_default, enabled FROM prompts WHERE id = ?',
);

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

async function handleStored({ message }) {
  if (!message || !message.id) {
    log.warn('message:stored without message.id — ignoring');
    return;
  }

  if (!isLlmConfigured()) {
    log.warn(
      { message_id: message.id },
      'openrouter_api_key is not configured — skipping LLM classification',
    );
    return;
  }

  try {
    const out = await classifyMessage(message);
    if (!out.ok) {
      // classifyMessage уже залогировала + записала error payload в БД.
      return;
    }
    // Перечитываем свежее состояние (с обновлёнными classification_json/is_important).
    const fresh = getMessageById(message.id);
    const apiMessage = rowForApi(fresh) || message;
    const prompt = out.prompt_id ? selectPromptStmt.get(out.prompt_id) : pickPromptForMessage();

    mailEvents.emit('message:classified', {
      message: apiMessage,
      classification: out.result,
      prompt: prompt || null,
    });
  } catch (err) {
    // Ключ мог быть убран между проверкой и вызовом, либо другая сквозная ошибка.
    if (err && err.code === 'openrouter_key_missing') {
      log.warn({ message_id: message.id }, 'openrouter_api_key missing at call time — skipped');
      return;
    }
    log.error(
      { err: err?.message || String(err), message_id: message.id },
      'classifier pipeline unexpected error',
    );
  }
}

/**
 * Зарегистрировать подписку classifier-pipeline на mailEvents.'message:stored'.
 * Идемпотентно — повторный вызов ничего не делает.
 */
export function registerClassifierPipeline() {
  if (registered) return;
  registered = true;
  mailEvents.on('message:stored', (payload) => {
    // Не await'им — pipeline асинхронный, но ошибки ловим внутри handleStored.
    handleStored(payload).catch((err) =>
      log.error({ err: err?.message || String(err) }, 'unhandled pipeline error'),
    );
  });
  log.info('classifier pipeline registered (message:stored → classify → message:classified)');
}
