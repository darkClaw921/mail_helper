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
  })
  .strict();

const updateSchema = createSchema.partial();

const selectAllStmt = db.prepare(
  'SELECT id, name, system_prompt, output_schema, output_params, model, is_default, enabled, created_at ' +
    'FROM prompts ORDER BY id',
);
const selectOneStmt = db.prepare(
  'SELECT id, name, system_prompt, output_schema, output_params, model, is_default, enabled, created_at ' +
    'FROM prompts WHERE id = ?',
);
const insertStmt = db.prepare(
  'INSERT INTO prompts (name, system_prompt, output_schema, output_params, model, is_default, enabled, created_at) ' +
    'VALUES (@name, @system_prompt, @output_schema, @output_params, @model, @is_default, @enabled, @created_at)',
);
const clearDefaultsStmt = db.prepare(
  'UPDATE prompts SET is_default = 0 WHERE is_default = 1 AND id <> ?',
);
const clearAllDefaultsStmt = db.prepare('UPDATE prompts SET is_default = 0 WHERE is_default = 1');
const deleteStmt = db.prepare('DELETE FROM prompts WHERE id = ?');

/**
 * Нормализует запись из БД для ответа API: output_params возвращается в виде массива,
 * а не JSON-строки (пользователю/UI удобнее работать с объектами).
 */
function shapeRow(row) {
  if (!row) return row;
  return { ...row, output_params: parseOutputParams(row.output_params) };
}

router.get('/', (_req, res) => {
  res.json({ prompts: selectAllStmt.all().map(shapeRow) });
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
