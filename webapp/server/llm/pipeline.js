// pipeline.js — мультипромтовая классификация входящих писем.
//
// Подписывается на mailEvents.'message:stored' и для каждого письма:
//   1. Получает ВСЕ enabled промты через getAllEnabledPrompts().
//   2. Дефолтный промт (первый, is_default DESC) — persist=true (пишет
//      classification_json/is_important/prompt_id в messages для UI).
//   3. Остальные промты — persist=false (только для dispatch actions).
//   4. После всех промтов — UPDATE messages.tokens_used/cost суммой ВСЕХ запросов.
//   5. Для каждого успешного промта эмитит 'message:classified' с per-prompt
//      tokens/cost в payload (для корректной атрибуции в runner).
//
// Идемпотентность: registerClassifierPipeline() — один раз за процесс.

import { mailEvents } from '../mail/events.js';
import { logger } from '../logger.js';
import { db } from '../db/index.js';
import {
  classifyMessage,
  getMessageById,
  isLlmConfigured,
  getAllEnabledPrompts,
  pickPromptForMessage,
  updateMessageTotals,
} from './classifier.js';

const log = logger.child({ module: 'llmPipeline' });

let registered = false;

const selectPromptStmt = db.prepare(
  'SELECT id, name, system_prompt, output_schema, model, is_default, enabled FROM prompts WHERE id = ?',
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

/**
 * Классифицирует письмо одним промтом и эмитит 'message:classified'.
 * Возвращает { tokens, cost } для накопления суммы.
 */
async function classifyWithPrompt(message, prompt, persist) {
  try {
    const out = await classifyMessage(message, {
      prompt,
      persist,
      force: true,
    });
    if (!out.ok) {
      log.warn(
        { message_id: message.id, prompt_id: prompt.id, prompt_name: prompt.name },
        'classification failed for prompt',
      );
      return { tokens: out.tokens ?? 0, cost: out.cost ?? 0 };
    }

    let apiMessage;
    if (persist) {
      const fresh = getMessageById(message.id);
      apiMessage = rowForApi(fresh) || message;
    } else {
      apiMessage = { ...message, classification: out.result };
    }

    // Per-prompt tokens/cost передаём в event — runner использует их
    // для атрибуции в action_runs, а не messages.tokens_used.
    mailEvents.emit('message:classified', {
      message: apiMessage,
      classification: out.result,
      prompt: prompt || null,
      tokens: out.tokens ?? null,
      cost: out.cost ?? null,
    });

    return { tokens: out.tokens ?? 0, cost: out.cost ?? 0 };
  } catch (err) {
    if (err && err.code === 'openrouter_key_missing') {
      log.warn({ message_id: message.id }, 'openrouter_api_key missing at call time — skipped');
      return { tokens: 0, cost: 0 };
    }
    log.error(
      {
        err: err?.message || String(err),
        message_id: message.id,
        prompt_id: prompt.id,
        prompt_name: prompt.name,
      },
      'classifier pipeline error for prompt',
    );
    return { tokens: 0, cost: 0 };
  }
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

  const prompts = getAllEnabledPrompts();
  if (!prompts.length) {
    const fallback = pickPromptForMessage();
    if (!fallback) {
      log.warn({ message_id: message.id }, 'no prompts found — skipping classification');
      return;
    }
    await classifyWithPrompt(message, fallback, true);
    return;
  }

  // Классифицируем ВСЕМИ промтами, накапливаем суммарные tokens/cost.
  let totalTokens = 0;
  let totalCost = 0;

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const isFirst = i === 0;
    const { tokens, cost } = await classifyWithPrompt(message, prompt, isFirst);
    totalTokens += tokens || 0;
    totalCost += cost || 0;
  }

  // UPDATE messages с суммарными tokens/cost по ВСЕМ промтам.
  // Дефолтный промт уже записал свои tokens/cost через persist=true —
  // перезаписываем суммой (включая его).
  if (totalTokens > 0 || totalCost > 0) {
    try {
      updateMessageTotals(
        message.id,
        totalTokens || null,
        totalCost || null,
      );
    } catch (err) {
      log.error(
        { err: err?.message || String(err), message_id: message.id },
        'failed to update message totals',
      );
    }
  }

  log.info(
    {
      message_id: message.id,
      prompts_count: prompts.length,
      total_tokens: totalTokens,
      total_cost: totalCost,
    },
    'multi-prompt classification complete',
  );
}

export function registerClassifierPipeline() {
  if (registered) return;
  registered = true;
  mailEvents.on('message:stored', (payload) => {
    handleStored(payload).catch((err) =>
      log.error({ err: err?.message || String(err) }, 'unhandled pipeline error'),
    );
  });
  log.info('classifier pipeline registered (message:stored → classify ALL enabled prompts → message:classified)');
}
