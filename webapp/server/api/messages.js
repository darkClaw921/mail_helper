// REST /api/messages — чтение уже полученных писем и обновление флагов.
// PATCH делегирует в services/messages.markFlags, который:
//   * обновляет БД (is_read / is_important),
//   * fire-and-forget синкит \Seen в IMAP через accountManager.getWorker(account_id),
//   * эмитит mailEvents 'message:updated' — WS hub подписан и сам шлёт broadcast.
// См. Ф8: mh-dq9.1, mh-dq9.3.

import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { markFlags } from '../services/messages.js';

const router = Router();

const LIST_COLUMNS =
  'id, account_id, uid, message_id, subject, from_addr, to_addr, date, snippet, ' +
  'is_read, is_important, classification_json, prompt_id, tokens_used, created_at';

const ONE_COLUMNS = LIST_COLUMNS + ', body_text, body_html';

const listQuerySchema = z.object({
  account_id: z.coerce.number().int().positive().optional(),
  unread: z.coerce.number().int().min(0).max(1).optional(),
  important: z.coerce.number().int().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const patchBodySchema = z
  .object({
    is_read: z
      .union([z.boolean(), z.number().int().min(0).max(1)])
      .transform((v) => (v ? 1 : 0))
      .optional(),
    is_important: z
      .union([z.boolean(), z.number().int().min(0).max(1)])
      .transform((v) => (v ? 1 : 0))
      .optional(),
  })
  .strict();

function parseClassification(row) {
  if (!row) return null;
  let classification = null;
  if (row.classification_json) {
    try {
      classification = JSON.parse(row.classification_json);
    } catch {
      classification = null;
    }
  }
  return { ...row, classification };
}

// GET /api/messages
router.get('/', (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.errors });
  }
  const { account_id, unread, important, limit, offset } = parsed.data;

  const where = [];
  const params = {};
  if (account_id !== undefined) {
    where.push('account_id = @account_id');
    params.account_id = account_id;
  }
  if (unread === 1) where.push('is_read = 0');
  if (unread === 0) where.push('is_read = 1');
  if (important !== undefined) {
    where.push('is_important = @important');
    params.important = important;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql =
    `SELECT ${LIST_COLUMNS} FROM messages ${whereSql} ` +
    'ORDER BY date DESC, id DESC LIMIT @limit OFFSET @offset';
  params.limit = limit;
  params.offset = offset;

  const rows = db.prepare(sql).all(params).map(parseClassification);
  const countRow = db
    .prepare(`SELECT COUNT(*) AS n FROM messages ${whereSql}`)
    .get(params);

  res.json({
    messages: rows,
    total: countRow?.n ?? 0,
    limit,
    offset,
  });
});

// GET /api/messages/:id
router.get('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const row = db.prepare(`SELECT ${ONE_COLUMNS} FROM messages WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(parseClassification(row));
});

// PATCH /api/messages/:id — обновление флагов + IMAP-синк \Seen.
// Логика вынесена в services/messages.markFlags (переиспользуется WS mark_read).
router.patch('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

  const parsed = patchBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.errors });
  }
  const d = parsed.data;

  const result = markFlags(id, d);
  if (!result.ok) {
    if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(400).json({ error: result.error });
  }
  res.json(result.message);
});

export default router;
