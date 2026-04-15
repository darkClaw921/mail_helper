// REST /api/settings — глобальные настройки (openrouter_api_key, telegram_bot_token, api_key).
// Значения всегда хранятся в таблице settings зашифрованными через crypto.encrypt.
// GET возвращает маску '***' вместо plain-text + булевы has_*. PUT принимает
// значения plain-text, шифрует и сохраняет.

import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { encrypt } from '../db/crypto.js';

const router = Router();

// Известные ключи, которыми управляет этот ресурс.
const KNOWN_KEYS = ['openrouter_api_key', 'telegram_bot_token', 'api_key'];

const selectStmt = db.prepare('SELECT value_enc FROM settings WHERE key = ?');
const upsertStmt = db.prepare(
  'INSERT INTO settings (key, value_enc) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc',
);

function hasValue(key) {
  const row = selectStmt.get(key);
  return !!row?.value_enc;
}

// Zod: допускаем undefined (не обновлять), но если передали — это непустая строка.
const putSchema = z
  .object({
    openrouter_api_key: z.string().min(1).optional(),
    telegram_bot_token: z.string().min(1).optional(),
    api_key: z.string().min(1).optional(),
  })
  .strict();

router.get('/', (_req, res) => {
  const out = {};
  for (const key of KNOWN_KEYS) {
    const present = hasValue(key);
    out[key] = present ? '***' : null;
    out[`has_${key}`] = present;
  }
  res.json(out);
});

router.put('/', (req, res) => {
  const parsed = putSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_error',
      details: parsed.error.errors,
    });
  }
  const updated = [];
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) {
      upsertStmt.run(key, encrypt(value));
      updated.push(key);
    }
  });
  tx(Object.entries(parsed.data));

  const out = {};
  for (const key of KNOWN_KEYS) {
    const present = hasValue(key);
    out[key] = present ? '***' : null;
    out[`has_${key}`] = present;
  }
  res.json({ ok: true, updated, ...out });
});

export default router;
