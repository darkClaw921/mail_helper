// REST /api/accounts — CRUD для почтовых аккаунтов (IMAP/SMTP).
// Пароли (imap_pass, smtp_pass) приходят plain-text в POST/PUT, шифруются
// через crypto.encrypt и сохраняются в *_enc. В GET никогда не возвращаются —
// вместо этого отдаются булевы флаги has_imap_pass / has_smtp_pass.

import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { encrypt } from '../db/crypto.js';
import { reloadAccount } from '../mail/accountManager.js';
import { ImapWorker } from '../mail/imapWorker.js';
import { testSmtp } from '../mail/smtp.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'api/accounts' });

const router = Router();

const zBoolInt = z
  .union([z.boolean(), z.number().int().min(0).max(1)])
  .transform((v) => (v ? 1 : 0));

const createSchema = z
  .object({
    label: z.string().min(1),
    email: z.string().email(),
    imap_host: z.string().min(1).optional().nullable(),
    imap_port: z.number().int().positive().optional().nullable(),
    imap_tls: zBoolInt.optional(),
    imap_user: z.string().optional().nullable(),
    imap_pass: z.string().optional().nullable(),
    smtp_host: z.string().min(1).optional().nullable(),
    smtp_port: z.number().int().positive().optional().nullable(),
    smtp_tls: zBoolInt.optional(),
    smtp_user: z.string().optional().nullable(),
    smtp_pass: z.string().optional().nullable(),
    folder: z.string().optional(),
    enabled: zBoolInt.optional(),
    initial_sync_count: z.number().int().min(-1).optional().nullable(),
    initial_synced: zBoolInt.optional(),
  })
  .strict();

// PUT: всё опционально; пустая строка пароля значит «не трогать».
const updateSchema = createSchema.partial();

const selectAllStmt = db.prepare(
  'SELECT id, label, email, imap_host, imap_port, imap_tls, imap_user, imap_pass_enc, ' +
    'smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass_enc, folder, enabled, initial_sync_count, initial_synced, created_at ' +
    'FROM accounts ORDER BY id',
);
const selectOneStmt = db.prepare(
  'SELECT id, label, email, imap_host, imap_port, imap_tls, imap_user, imap_pass_enc, ' +
    'smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass_enc, folder, enabled, initial_sync_count, initial_synced, created_at ' +
    'FROM accounts WHERE id = ?',
);
const insertStmt = db.prepare(
  'INSERT INTO accounts (label, email, imap_host, imap_port, imap_tls, imap_user, imap_pass_enc, ' +
    'smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass_enc, folder, enabled, initial_sync_count, initial_synced, created_at) ' +
    'VALUES (@label, @email, @imap_host, @imap_port, @imap_tls, @imap_user, @imap_pass_enc, ' +
    '@smtp_host, @smtp_port, @smtp_tls, @smtp_user, @smtp_pass_enc, @folder, @enabled, @initial_sync_count, @initial_synced, @created_at)',
);
const deleteStmt = db.prepare('DELETE FROM accounts WHERE id = ?');

function rowToApi(row) {
  if (!row) return null;
  const { imap_pass_enc, smtp_pass_enc, ...rest } = row;
  return {
    ...rest,
    has_imap_pass: !!imap_pass_enc,
    has_smtp_pass: !!smtp_pass_enc,
  };
}

// GET /api/accounts
router.get('/', (_req, res) => {
  const rows = selectAllStmt.all();
  res.json({ accounts: rows.map(rowToApi) });
});

// GET /api/accounts/:id
router.get('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const row = selectOneStmt.get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(rowToApi(row));
});

// POST /api/accounts
router.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.errors });
  }
  const d = parsed.data;
  const imap_pass_enc = d.imap_pass ? encrypt(d.imap_pass) : null;
  const smtp_pass_enc = d.smtp_pass ? encrypt(d.smtp_pass) : null;

  const info = insertStmt.run({
    label: d.label,
    email: d.email,
    imap_host: d.imap_host ?? null,
    imap_port: d.imap_port ?? null,
    imap_tls: d.imap_tls ?? 1,
    imap_user: d.imap_user ?? null,
    imap_pass_enc,
    smtp_host: d.smtp_host ?? null,
    smtp_port: d.smtp_port ?? null,
    smtp_tls: d.smtp_tls ?? 1,
    smtp_user: d.smtp_user ?? null,
    smtp_pass_enc,
    folder: d.folder ?? 'INBOX',
    enabled: d.enabled ?? 1,
    initial_sync_count: d.initial_sync_count ?? null,
    initial_synced: 0,
    created_at: Math.floor(Date.now() / 1000),
  });
  const row = selectOneStmt.get(info.lastInsertRowid);
  // Запустить IMAP воркер (если enabled и есть imap_*).
  reloadAccount(row.id).catch((err) =>
    log.error({ err: err?.message || String(err), id: row.id }, 'reloadAccount failed'),
  );
  res.status(201).json(rowToApi(row));
});

// PUT /api/accounts/:id
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

  // Собираем динамический UPDATE только из переданных полей.
  const sets = [];
  const values = {};
  const assign = (col, value) => {
    sets.push(`${col} = @${col}`);
    values[col] = value;
  };

  if (d.label !== undefined) assign('label', d.label);
  if (d.email !== undefined) assign('email', d.email);
  if (d.imap_host !== undefined) assign('imap_host', d.imap_host);
  if (d.imap_port !== undefined) assign('imap_port', d.imap_port);
  if (d.imap_tls !== undefined) assign('imap_tls', d.imap_tls);
  if (d.imap_user !== undefined) assign('imap_user', d.imap_user);
  if (d.smtp_host !== undefined) assign('smtp_host', d.smtp_host);
  if (d.smtp_port !== undefined) assign('smtp_port', d.smtp_port);
  if (d.smtp_tls !== undefined) assign('smtp_tls', d.smtp_tls);
  if (d.smtp_user !== undefined) assign('smtp_user', d.smtp_user);
  if (d.folder !== undefined) assign('folder', d.folder);
  if (d.enabled !== undefined) assign('enabled', d.enabled);
  if (d.initial_sync_count !== undefined) {
    assign('initial_sync_count', d.initial_sync_count);
    // При изменении плана первичного sync — сбрасываем флаг, чтобы воркер перезапустил sync.
    assign('initial_synced', 0);
  }
  if (d.initial_synced !== undefined) assign('initial_synced', d.initial_synced);

  // Пароли пересохраняем только если передана непустая строка.
  if (typeof d.imap_pass === 'string' && d.imap_pass.length > 0) {
    assign('imap_pass_enc', encrypt(d.imap_pass));
  }
  if (typeof d.smtp_pass === 'string' && d.smtp_pass.length > 0) {
    assign('smtp_pass_enc', encrypt(d.smtp_pass));
  }

  if (sets.length === 0) {
    return res.json(rowToApi(existing));
  }

  const sql = `UPDATE accounts SET ${sets.join(', ')} WHERE id = @id`;
  values.id = id;
  db.prepare(sql).run(values);

  const row = selectOneStmt.get(id);
  // Рестарт воркера (перечитает новые креды/folder/enabled).
  reloadAccount(id).catch((err) =>
    log.error({ err: err?.message || String(err), id }, 'reloadAccount failed'),
  );
  res.json(rowToApi(row));
});

// DELETE /api/accounts/:id
router.delete('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const info = deleteStmt.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  // После удаления воркер должен остановиться.
  reloadAccount(id).catch((err) =>
    log.error({ err: err?.message || String(err), id }, 'reloadAccount failed'),
  );
  res.json({ ok: true, id });
});

// POST /api/accounts/:id/test — проверка IMAP + SMTP креденшиалов.
router.post('/:id/test', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
    const row = selectOneStmt.get(id);
    if (!row) return res.status(404).json({ error: 'not_found' });

    // Параллельно проверяем IMAP и SMTP — обе функции безопасны и всегда
    // возвращают { ok, error? } (не кидают).
    const [imapResult, smtpResult] = await Promise.all([
      ImapWorker.testConnection(row),
      testSmtp(row),
    ]);
    res.json({ imap: imapResult, smtp: smtpResult });
  } catch (err) {
    next(err);
  }
});

export default router;
