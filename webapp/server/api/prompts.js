// REST /api/prompts — CRUD для LLM промтов-классификаторов.
// Инвариант: только один prompt может иметь is_default=1. Установка is_default=1
// через POST/PUT автоматически снимает этот флаг у всех остальных записей в
// одной транзакции.

import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { classify } from '../llm/openrouter.js';
import {
  buildUserPrompt,
  composeSystemPrompt,
  parseOutputParams,
} from '../llm/classifier.js';

const router = Router();

const zBoolInt = z
  .union([z.boolean(), z.number().int().min(0).max(1)])
  .transform((v) => (v ? 1 : 0));

// Разрешённые типы выходных параметров (в JSON-контракте LLM и как whitelist для evaluator).
const OUTPUT_PARAM_TYPES = ['boolean', 'string', 'number', 'string[]', 'object'];

const zOutputParam = z
  .object({
    key: z
      .string()
      .min(1)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'key must be a valid identifier'),
    type: z.enum(OUTPUT_PARAM_TYPES).default('string'),
    description: z.string().optional().default(''),
    required: z.boolean().optional().default(false),
  })
  .strict();

const createSchema = z
  .object({
    name: z.string().min(1),
    system_prompt: z.string().min(1),
    output_schema: z.string().optional().nullable(),
    output_params: z.array(zOutputParam).optional().nullable(),
    model: z.string().optional().nullable(),
    is_default: zBoolInt.optional(),
    enabled: zBoolInt.optional(),
    // Ф3.3 — режим выполнения правил ('all' → все matched, 'first' → только первое).
    match_mode: z.enum(['all', 'first']).optional(),
  })
  .strict();

const updateSchema = createSchema.partial();

const selectAllStmt = db.prepare(
  'SELECT id, name, system_prompt, output_schema, output_params, model, is_default, enabled, match_mode, created_at ' +
    'FROM prompts ORDER BY id',
);
const selectOneStmt = db.prepare(
  'SELECT id, name, system_prompt, output_schema, output_params, model, is_default, enabled, match_mode, created_at ' +
    'FROM prompts WHERE id = ?',
);
const insertStmt = db.prepare(
  'INSERT INTO prompts (name, system_prompt, output_schema, output_params, model, is_default, enabled, match_mode, created_at) ' +
    'VALUES (@name, @system_prompt, @output_schema, @output_params, @model, @is_default, @enabled, @match_mode, @created_at)',
);
const clearDefaultsStmt = db.prepare(
  'UPDATE prompts SET is_default = 0 WHERE is_default = 1 AND id <> ?',
);
const clearAllDefaultsStmt = db.prepare('UPDATE prompts SET is_default = 0 WHERE is_default = 1');
const deleteStmt = db.prepare('DELETE FROM prompts WHERE id = ?');

// Per-prompt stats из action_runs (через actions.prompt_id).
// Дедупликация по message_id: GROUP BY message_id берёт MAX tokens/cost
// (все action_runs одного prompt+message имеют одинаковые per-prompt значения).
const selectPromptStatsStmt = db.prepare(
  `SELECT COUNT(*)                       AS messages_classified,
          COALESCE(SUM(tokens_used), 0)  AS tokens_total,
          COALESCE(SUM(cost), 0)         AS cost_total
     FROM (
       SELECT ar.message_id,
              MAX(ar.tokens_used) AS tokens_used,
              MAX(ar.cost)        AS cost
         FROM action_runs ar
         JOIN actions a ON ar.action_id = a.id
        WHERE a.prompt_id = ?
        GROUP BY ar.message_id
     )`,
);

/**
 * Нормализует запись из БД для ответа API: output_params возвращается в виде массива,
 * а не JSON-строки (пользователю/UI удобнее работать с объектами).
 */
function shapeRow(row) {
  if (!row) return row;
  let stats = { messages_classified: 0, tokens_total: 0, cost_total: 0 };
  try {
    const s = selectPromptStatsStmt.get(row.id);
    if (s) {
      stats = {
        messages_classified: s.messages_classified ?? 0,
        tokens_total: s.tokens_total ?? 0,
        cost_total: s.cost_total ?? 0,
      };
    }
  } catch { /* fallback */ }
  return { ...row, output_params: parseOutputParams(row.output_params), stats };
}

router.get('/', (_req, res) => {
  res.json({ prompts: selectAllStmt.all().map(shapeRow) });
});

// POST /api/prompts/generate — AI-генерация промта по описанию пользователя.
// Body: { description: string } — текстовое описание задачи на естественном языке.
// Возвращает: { name, system_prompt, output_params }.
const generateSchema = z
  .object({
    description: z.string().min(3).max(5000),
  })
  .strict();

const GENERATE_SYSTEM_PROMPT = `Ты — эксперт по созданию промтов для email-классификатора MailMind AI.

Пользователь опишет, что ему нужно. Ты должен сгенерировать полную конфигурацию промта, включая правила маршрутизации (actions).

Верни СТРОГО JSON объект с полями:
{
  "name": "Краткое название промта (до 60 символов, на языке описания пользователя)",
  "system_prompt": "Инструкция для LLM-классификатора. Опиши ТОЛЬКО бизнес-логику: что считать важным, какие категории/теги ставить, критерии классификации. НЕ включай описание формата входа (subject/from/body) и структуры JSON-ответа — они добавляются автоматически. Пиши от второго лица ('Ты — классификатор...'). На языке описания пользователя.",
  "output_params": [
    {
      "key": "имя_поля (латиница, snake_case)",
      "type": "boolean|string|number|string[]|object",
      "description": "Описание поля для LLM",
      "required": true_или_false
    }
  ],
  "rules": [
    {
      "match_expr": "выражение-условие, например: important == true",
      "type": "telegram|webhook|forward|browser",
      "config": {},
      "enabled": 1
    }
  ]
}

Правила для output_params:
- Всегда включай базовые поля: important (boolean), reason (string), tags (string[]), summary (string)
- Добавляй дополнительные поля если они нужны для описанной задачи
- key должен быть валидным идентификатором: начинается с буквы или _, содержит только латиницу, цифры и _
- type один из: boolean, string, number, string[], object

Правила для rules (действия маршрутизации):
- Генерируй правила на основе описания пользователя
- match_expr — безопасное выражение-условие. Доступные переменные: имена из output_params (important, reason, tags, summary и кастомные). Операторы: ==, !=, &&, ||, !. Единственный метод: .includes(). Литералы: строки в кавычках, числа, true, false, null. Примеры: "important == true", "tags.includes('urgent')", "important == true && tags.includes('finance')"
- type — тип действия: "telegram" (отправка в Telegram), "webhook" (HTTP POST на URL), "forward" (пересылка email), "browser" (браузерное уведомление)
- config зависит от type:
  - telegram: { "chat_id": "ID чата (пользователь заполнит)", "template": "опционально: шаблон с {subject}, {from}, {summary}, {reason}, {tags}" }
  - webhook: { "url": "URL (пользователь заполнит)" }
  - forward: { "to_email": "email (пользователь заполнит)" }
  - browser: { "title": "Заголовок уведомления" }
- Если пользователь упоминает Telegram — создай telegram-правило
- Если упоминает уведомления — создай browser-правило
- Если упоминает пересылку — создай forward-правило
- Если упоминает webhook/API — создай webhook-правило
- Если ничего конкретного не упомянуто, создай browser-правило для важных писем (match_expr: "important == true")
- enabled: 1 — правило активно
- Для config оставляй плейсхолдеры (пустые строки) для полей, которые пользователь должен заполнить сам (chat_id, url, to_email)

Генерируй качественную, детальную инструкцию в system_prompt. Она должна быть достаточно подробной, чтобы LLM понимал критерии классификации.`;

router.post('/generate', async (req, res) => {
  const parsed = generateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.errors });
  }

  const t0 = Date.now();
  try {
    const out = await classify({
      systemPrompt: GENERATE_SYSTEM_PROMPT,
      userPrompt: parsed.data.description,
      timeoutMs: 60_000,
    });

    const result = out.result;
    if (!result || typeof result.name !== 'string' || typeof result.system_prompt !== 'string') {
      return res.status(502).json({
        error: 'llm_bad_response',
        message: 'LLM вернул некорректную структуру',
        raw: result,
        duration_ms: out.durationMs,
      });
    }

    const params = Array.isArray(result.output_params)
      ? result.output_params
          .filter((p) => p && typeof p.key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.key))
          .map((p) => ({
            key: p.key,
            type: OUTPUT_PARAM_TYPES.includes(p.type) ? p.type : 'string',
            description: typeof p.description === 'string' ? p.description : '',
            required: p.required === true,
          }))
      : [];

    // Нормализуем rules.
    const VALID_RULE_TYPES = ['telegram', 'webhook', 'forward', 'browser'];
    const rules = Array.isArray(result.rules)
      ? result.rules
          .filter((r) => r && typeof r === 'object' && VALID_RULE_TYPES.includes(r.type))
          .map((r) => ({
            match_expr: typeof r.match_expr === 'string' ? r.match_expr : '1 == 1',
            type: r.type,
            config: r.config && typeof r.config === 'object' ? r.config : {},
            enabled: r.enabled === 0 ? 0 : 1,
          }))
      : [];

    return res.json({
      ok: true,
      name: result.name,
      system_prompt: result.system_prompt,
      output_params: params,
      rules,
      tokens_used: out.usage?.total_tokens ?? null,
      duration_ms: out.durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - t0;
    if (err && err.code === 'openrouter_key_missing') {
      return res.status(400).json({
        error: 'openrouter_key_missing',
        message: 'openrouter_api_key не настроен в /api/settings',
        duration_ms: durationMs,
      });
    }
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status === 400 || status === 401 || status === 403 ? status : 502).json({
      error: 'llm_error',
      message: err?.message || 'LLM error',
      duration_ms: durationMs,
    });
  }
});

router.get('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const row = selectOneStmt.get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(shapeRow(row));
});

router.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.errors });
  }
  const d = parsed.data;
  const tx = db.transaction(() => {
    if (d.is_default === 1) clearAllDefaultsStmt.run();
    const info = insertStmt.run({
      name: d.name,
      system_prompt: d.system_prompt,
      output_schema: d.output_schema ?? null,
      output_params:
        d.output_params == null ? null : JSON.stringify(d.output_params),
      model: d.model ?? null,
      is_default: d.is_default ?? 0,
      enabled: d.enabled ?? 1,
      match_mode: d.match_mode ?? 'all',
      created_at: Math.floor(Date.now() / 1000),
    });
    return info.lastInsertRowid;
  });
  const id = tx();
  res.status(201).json(shapeRow(selectOneStmt.get(id)));
});

router.put('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const existing = selectOneStmt.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.errors });
  }
  const d = parsed.data;

  const sets = [];
  const values = {};
  const assign = (col, value) => {
    sets.push(`${col} = @${col}`);
    values[col] = value;
  };
  if (d.name !== undefined) assign('name', d.name);
  if (d.system_prompt !== undefined) assign('system_prompt', d.system_prompt);
  if (d.output_schema !== undefined) assign('output_schema', d.output_schema);
  if (d.output_params !== undefined) {
    assign(
      'output_params',
      d.output_params == null ? null : JSON.stringify(d.output_params),
    );
  }
  if (d.model !== undefined) assign('model', d.model);
  if (d.is_default !== undefined) assign('is_default', d.is_default);
  if (d.enabled !== undefined) assign('enabled', d.enabled);
  if (d.match_mode !== undefined) assign('match_mode', d.match_mode);

  const tx = db.transaction(() => {
    if (d.is_default === 1) clearDefaultsStmt.run(id);
    if (sets.length > 0) {
      values.id = id;
      db.prepare(`UPDATE prompts SET ${sets.join(', ')} WHERE id = @id`).run(values);
    }
  });
  tx();

  res.json(shapeRow(selectOneStmt.get(id)));
});

// POST /api/prompts/:id/test — прогон промта через LLM на заданном или последнем письме.
// Body (опц): { message_id?: number } или { message?: { subject, from_addr, to_addr, body_text } }
// Результат НЕ сохраняется в БД — только возвращается клиенту.
const testBodySchema = z
  .object({
    message_id: z.number().int().positive().optional(),
    message: z
      .object({
        subject: z.string().optional(),
        from_addr: z.string().optional(),
        to_addr: z.string().optional(),
        body_text: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .strict()
  .optional();

const selectMessageByIdStmt = db.prepare(
  'SELECT id, subject, from_addr, to_addr, body_text FROM messages WHERE id = ?',
);
const selectLatestMessageStmt = db.prepare(
  'SELECT id, subject, from_addr, to_addr, body_text FROM messages ' +
    'ORDER BY COALESCE(date, 0) DESC, id DESC LIMIT 1',
);

router.post('/:id/test', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const prompt = selectOneStmt.get(id);
  if (!prompt) return res.status(404).json({ error: 'not_found' });

  const parsed = testBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.errors });
  }
  const body = parsed.data || {};

  // 1. Определяем тестовое письмо.
  let testMessage = null;
  if (body.message) {
    testMessage = {
      subject: body.message.subject ?? '',
      from_addr: body.message.from_addr ?? '',
      to_addr: body.message.to_addr ?? '',
      body_text: body.message.body_text ?? '',
    };
  } else if (body.message_id) {
    testMessage = selectMessageByIdStmt.get(body.message_id);
    if (!testMessage) return res.status(404).json({ error: 'message_not_found' });
  } else {
    testMessage = selectLatestMessageStmt.get();
    if (!testMessage) {
      return res
        .status(400)
        .json({ error: 'no_messages', message: 'Нет писем для тестового прогона промта' });
    }
  }

  const userPrompt = buildUserPrompt(testMessage);
  const t0 = Date.now();
  try {
    const out = await classify({
      systemPrompt: composeSystemPrompt(prompt.system_prompt, {
        params: prompt.output_params,
        schemaJson: prompt.output_schema,
      }),
      userPrompt,
      ...(prompt.model ? { model: prompt.model } : {}),
    });
    return res.json({
      ok: true,
      result: out.result,
      tokens_used: out.usage?.total_tokens ?? null,
      usage: out.usage || null,
      duration_ms: out.durationMs,
      message_id: testMessage.id ?? null,
    });
  } catch (err) {
    const durationMs = Date.now() - t0;
    if (err && err.code === 'openrouter_key_missing') {
      return res.status(400).json({
        error: 'openrouter_key_missing',
        message: 'openrouter_api_key не настроен в /api/settings',
        duration_ms: durationMs,
      });
    }
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status === 400 || status === 401 || status === 403 ? status : 502).json({
      error: 'llm_error',
      message: err?.message || 'LLM error',
      duration_ms: durationMs,
    });
  }
});

router.delete('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const info = deleteStmt.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, id });
});

export default router;
