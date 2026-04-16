// REST /api/actions — CRUD для действий по результату классификации.
// config приходит/отдаётся как JSON-объект; на диске хранится как
// JSON.stringify(config) и шифруется в config_enc. match_expr — plain-text
// строка выражения (evaluator появится в фазе 5). type — enum.

import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { encrypt, decrypt } from '../db/crypto.js';
import { compile, DEFAULT_ALLOWED_IDENTIFIERS } from '../actions/evaluator.js';
import { parseOutputParams } from '../llm/classifier.js';

const router = Router();

// Prepared-запрос: получение output_params промта для расчёта allowedIdents
// в POST /validate-expr. Повторяет паттерн `selectPromptParamsStmt` из
// actions/runner.js (resolveAllowedIdentifiers).
const selectPromptParamsStmt = db.prepare(
  'SELECT output_params FROM prompts WHERE id = ?',
);

/**
 * Собирает набор разрешённых идентификаторов для валидации match_expr.
 * Повторяет логику `resolveAllowedIdentifiers` из actions/runner.js:
 *   - если передан prompt_id → union(DEFAULT_ALLOWED_IDENTIFIERS, keys(output_params)).
 *   - иначе → только DEFAULT_ALLOWED_IDENTIFIERS.
 *
 * @param {number|null|undefined} promptId
 * @returns {{ ok: true, idents: Set<string> } | { ok: false, reason: 'prompt_not_found' }}
 */
function resolveAllowedIdentsForValidation(promptId) {
  const out = new Set(DEFAULT_ALLOWED_IDENTIFIERS);
  if (promptId == null) return { ok: true, idents: out };
  const row = selectPromptParamsStmt.get(promptId);
  if (!row) return { ok: false, reason: 'prompt_not_found' };
  for (const p of parseOutputParams(row.output_params)) {
    out.add(p.key);
  }
  return { ok: true, idents: out };
}

const ACTION_TYPES = ['telegram', 'webhook', 'forward', 'browser'];

const zBoolInt = z
  .union([z.boolean(), z.number().int().min(0).max(1)])
  .transform((v) => (v ? 1 : 0));

const createSchema = z
  .object({
    name: z.string().optional().nullable(),
    prompt_id: z.number().int().positive().optional().nullable(),
    match_expr: z.string().min(1),
    type: z.enum(ACTION_TYPES),
    config: z.record(z.any()).default({}),
    enabled: zBoolInt.optional(),
    // Ф3.3 — приоритет выполнения. Выше = раньше (ORDER BY priority DESC, id ASC).
    priority: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

const updateSchema = createSchema.partial();

// Zod-схема body для POST /api/actions/validate-expr. Разрешаем `prompt_id:null`
// для новых промтов (у которых ещё нет id) — в этом случае allowedIdents
// считаются от DEFAULT_ALLOWED_IDENTIFIERS.
const validateExprSchema = z
  .object({
    expr: z.string().min(1).max(2000),
    prompt_id: z.number().int().positive().nullable().optional(),
  })
  .strict();

const selectAllStmt = db.prepare(
  'SELECT id, name, prompt_id, match_expr, type, config_enc, enabled, priority FROM actions ORDER BY id',
);
// Выборка правил, привязанных к конкретному промту (фильтр ?prompt_id=<id>).
const selectByPromptStmt = db.prepare(
  'SELECT id, name, prompt_id, match_expr, type, config_enc, enabled, priority FROM actions WHERE prompt_id = ? ORDER BY id',
);
// Выборка «глобальных» правил (не привязанных к промту). Используется при
// prompt_id=global / null / '' — полезно для edge‑кейса, когда нужно увидеть
// правила, срабатывающие на любом письме.
const selectGlobalStmt = db.prepare(
  'SELECT id, name, prompt_id, match_expr, type, config_enc, enabled, priority FROM actions WHERE prompt_id IS NULL ORDER BY id',
);
const selectOneStmt = db.prepare(
  'SELECT id, name, prompt_id, match_expr, type, config_enc, enabled, priority FROM actions WHERE id = ?',
);
// Агрегаты запусков действия (для отображения «Токены: N · Срабатываний: M»).
const selectActionStatsStmt = db.prepare(
  `SELECT COUNT(*)                          AS runs_total,
          COALESCE(SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END), 0) AS runs_ok,
          COALESCE(SUM(tokens_used), 0)     AS tokens_total,
          MAX(created_at)                   AS last_run_at
     FROM action_runs WHERE action_id = ?`,
);
const insertStmt = db.prepare(
  'INSERT INTO actions (name, prompt_id, match_expr, type, config_enc, enabled, priority) ' +
    'VALUES (@name, @prompt_id, @match_expr, @type, @config_enc, @enabled, @priority)',
);
const deleteStmt = db.prepare('DELETE FROM actions WHERE id = ?');

function rowToApi(row) {
  if (!row) return null;
  let config = {};
  if (row.config_enc) {
    try {
      config = JSON.parse(decrypt(row.config_enc));
    } catch {
      config = {};
    }
  }
  const { config_enc, ...rest } = row;
  let stats = { runs_total: 0, runs_ok: 0, tokens_total: 0, last_run_at: null };
  try {
    const s = selectActionStatsStmt.get(row.id);
    if (s) {
      stats = {
        runs_total: s.runs_total ?? 0,
        runs_ok: s.runs_ok ?? 0,
        tokens_total: s.tokens_total ?? 0,
        last_run_at: s.last_run_at ?? null,
      };
    }
  } catch {
    /* fallback: пустые агрегаты */
  }
  return { ...rest, config, stats };
}

router.get('/', (req, res) => {
  // Опциональный фильтр ?prompt_id=<id|global|null|''>.
  // - не задан → все правила (обратная совместимость).
  // - 'global' | 'null' | '' → только «глобальные» (prompt_id IS NULL).
  // - положительное целое → правила этого промта.
  // - что-то иное → 400 invalid_prompt_id.
  let rows;
  if (Object.prototype.hasOwnProperty.call(req.query, 'prompt_id')) {
    const raw = req.query.prompt_id;
    const asStr = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
    if (asStr === '' || asStr === 'global' || asStr === 'null') {
      rows = selectGlobalStmt.all();
    } else {
      const n = Number(asStr);
      if (!Number.isInteger(n) || n <= 0) {
        return res.status(400).json({ error: 'invalid_prompt_id' });
      }
      rows = selectByPromptStmt.all(n);
    }
  } else {
    rows = selectAllStmt.all();
  }
  res.json({ actions: rows.map(rowToApi) });
});

router.get('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const row = selectOneStmt.get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(rowToApi(row));
});

// POST /api/actions/validate-expr — проверка синтаксиса match_expr без сохранения.
// Body: { expr: string, prompt_id?: number|null }.
// Ответ:
//   200 { ok: true }                              — выражение компилируется.
//   200 { ok: false, error: 'evaluator: ...' }    — синтаксическая ошибка (ОЖИДАЕМО, не 500).
//   400 { error: 'validation_error', details }    — Zod-ошибка тела.
//   404 { error: 'prompt_not_found' }             — prompt_id указан, но промт не найден.
//
// allowedIdents формируется как в actions/runner.js:resolveAllowedIdentifiers:
// union(DEFAULT_ALLOWED_IDENTIFIERS, ключи output_params промта), либо только
// дефолты, если prompt_id не передан.
router.post('/validate-expr', (req, res) => {
  const parsed = validateExprSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.errors });
  }
  const { expr, prompt_id } = parsed.data;

  const resolved = resolveAllowedIdentsForValidation(prompt_id ?? null);
  if (!resolved.ok) {
    return res.status(404).json({ error: 'prompt_not_found' });
  }

  try {
    compile(expr, resolved.idents);
    return res.json({ ok: true });
  } catch (err) {
    // Синтаксические ошибки выражения — ожидаемый флоу: 200 с ok:false.
    // Сообщение уже имеет префикс 'evaluator:' (см. evaluator.js).
    const msg = err?.message || String(err);
    return res.json({ ok: false, error: msg });
  }
});

router.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.errors });
  }
  const d = parsed.data;
  const info = insertStmt.run({
    name: d.name ?? null,
    prompt_id: d.prompt_id ?? null,
    match_expr: d.match_expr,
    type: d.type,
    config_enc: encrypt(JSON.stringify(d.config ?? {})),
    enabled: d.enabled ?? 1,
    priority: d.priority ?? 0,
  });
  res.status(201).json(rowToApi(selectOneStmt.get(info.lastInsertRowid)));
});

// PUT и PATCH семантически равны: updateSchema делает все поля optional,
// handler патчит только переданные. Клиент (views/prompts.js → actionsApi.patch)
// использует PATCH, редактор #/actions/:id/edit — PUT. Общий handler.
function updateActionHandler(req, res) {
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
  if (d.prompt_id !== undefined) assign('prompt_id', d.prompt_id);
  if (d.match_expr !== undefined) assign('match_expr', d.match_expr);
  if (d.type !== undefined) assign('type', d.type);
  if (d.enabled !== undefined) assign('enabled', d.enabled);
  if (d.priority !== undefined) assign('priority', d.priority);
  if (d.config !== undefined) assign('config_enc', encrypt(JSON.stringify(d.config)));

  if (sets.length > 0) {
    values.id = id;
    db.prepare(`UPDATE actions SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }
  res.json(rowToApi(selectOneStmt.get(id)));
}
router.put('/:id', updateActionHandler);
router.patch('/:id', updateActionHandler);

// POST /api/actions/:id/test — stub для кнопки «Запустить тест» в редакторе правил.
// Принимает опциональный { messageId } (не используется в stub-версии; оставлено
// в API на будущее для реального dry-run). Возвращает синтетический preview
// с триггером (match_expr) и типом action. Реальный evaluator+dispatcher
// подключим позже отдельной задачей.
router.post('/:id/test', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const row = selectOneStmt.get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  // messageId сейчас игнорируется — это stub. Считываем только чтобы
  // клиент мог начать его присылать прямо сейчас, не ломая совместимость.
  const _messageId = req.body?.messageId;
  void _messageId;

  res.json({
    ok: true,
    matched: true,
    preview: {
      trigger: row.match_expr,
      action_type: row.type,
      would_execute: true,
    },
  });
});

router.delete('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const info = deleteStmt.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, id });
});

export default router;
