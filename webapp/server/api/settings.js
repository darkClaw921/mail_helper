// REST /api/settings — глобальные настройки.
// Секреты (openrouter_api_key, telegram_bot_token, api_key) хранятся зашифрованными
// через crypto.encrypt. GET возвращает '***' + булевы has_*.
// Простые настройки (currency, currency_rate) хранятся в plain-text (value_enc = plain).

import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { encrypt } from '../db/crypto.js';

const router = Router();

// Секретные ключи — шифруются.
const SECRET_KEYS = ['openrouter_api_key', 'telegram_bot_token', 'api_key'];
// Обычные ключи — хранятся plain-text в value_enc.
const PLAIN_KEYS = ['currency', 'currency_rate'];

const selectStmt = db.prepare('SELECT value_enc FROM settings WHERE key = ?');
const upsertStmt = db.prepare(
  'INSERT INTO settings (key, value_enc) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc',
);

function hasValue(key) {
  const row = selectStmt.get(key);
  return !!row?.value_enc;
}

function getPlainValue(key) {
  const row = selectStmt.get(key);
  return row?.value_enc ?? null;
}

const putSchema = z
  .object({
    openrouter_api_key: z.string().min(1).optional(),
    telegram_bot_token: z.string().min(1).optional(),
    api_key: z.string().min(1).optional(),
    currency: z.enum(['USD', 'RUB']).optional(),
    currency_rate: z.union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?$/)]).optional(),
  })
  .strict();

router.get('/', (_req, res) => {
  const out = {};
  for (const key of SECRET_KEYS) {
    const present = hasValue(key);
    out[key] = present ? '***' : null;
    out[`has_${key}`] = present;
  }
  // Plain settings — возвращаем как есть.
  out.currency = getPlainValue('currency') || 'USD';
  out.currency_rate = parseFloat(getPlainValue('currency_rate')) || null;
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
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (SECRET_KEYS.includes(key)) {
        upsertStmt.run(key, encrypt(value));
      } else if (PLAIN_KEYS.includes(key)) {
        upsertStmt.run(key, String(value));
      }
      updated.push(key);
    }
  });
  tx();

  const out = {};
  for (const key of SECRET_KEYS) {
    const present = hasValue(key);
    out[key] = present ? '***' : null;
    out[`has_${key}`] = present;
  }
  out.currency = getPlainValue('currency') || 'USD';
  out.currency_rate = parseFloat(getPlainValue('currency_rate')) || null;
  res.json({ ok: true, updated, ...out });
});

export default router;
