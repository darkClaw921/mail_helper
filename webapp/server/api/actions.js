// REST /api/actions — CRUD для действий по результату классификации.
// config приходит/отдаётся как JSON-объект; на диске хранится как
// JSON.stringify(config) и шифруется в config_enc. match_expr — plain-text
// строка выражения (evaluator появится в фазе 5). type — enum.

import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { encrypt, decrypt } from '../db/crypto.js';

const router = Router();

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
  })
  .strict();

const updateSchema = createSchema.partial();

const selectAllStmt = db.prepare(
  'SELECT id, name, prompt_id, match_expr, type, config_enc, enabled FROM actions ORDER BY id',
);
const selectOneStmt = db.prepare(
  'SELECT id, name, prompt_id, match_expr, type, config_enc, enabled FROM actions WHERE id = ?',
);
const insertStmt = db.prepare(
  'INSERT INTO actions (name, prompt_id, match_expr, type, config_enc, enabled) ' +
    'VALUES (@name, @prompt_id, @match_expr, @type, @config_enc, @enabled)',
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
  return { ...rest, config };
}

router.get('/', (_req, res) => {
  const rows = selectAllStmt.all();
  res.json({ actions: rows.map(rowToApi) });
});

router.get('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const row = selectOneStmt.get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(rowToApi(row));
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
  });
  res.status(201).json(rowToApi(selectOneStmt.get(info.lastInsertRowid)));
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
  if (d.prompt_id !== undefined) assign('prompt_id', d.prompt_id);
  if (d.match_expr !== undefined) assign('match_expr', d.match_expr);
  if (d.type !== undefined) assign('type', d.type);
  if (d.enabled !== undefined) assign('enabled', d.enabled);
  if (d.config !== undefined) assign('config_enc', encrypt(JSON.stringify(d.config)));

  if (sets.length > 0) {
    values.id = id;
    db.prepare(`UPDATE actions SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }
  res.json(rowToApi(selectOneStmt.get(id)));
});

router.delete('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const info = deleteStmt.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, id });
});

export default router;
