// Middleware проверки X-API-Key.
//
// При первом запуске генерирует случайный UUID, шифрует через crypto.js и кладёт
// в таблицу settings (key='api_key'). Ключ логируется один раз в info — админ
// должен записать его для плагина/UI. /api/health не требует ключа.

import { randomUUID, timingSafeEqual } from 'node:crypto';

import { db } from '../db/index.js';
import { encrypt, decrypt } from '../db/crypto.js';
import { logger } from '../logger.js';

const SETTINGS_KEY = 'api_key';
const PUBLIC_PATHS = new Set(['/api/health']);

const selectStmt = db.prepare('SELECT value_enc FROM settings WHERE key = ?');
const insertStmt = db.prepare('INSERT INTO settings (key, value_enc) VALUES (?, ?)');

/**
 * Возвращает текущий api_key (plaintext). При отсутствии — создаёт и логирует.
 */
export function ensureApiKey() {
  const row = selectStmt.get(SETTINGS_KEY);
  if (row?.value_enc) {
    try {
      return decrypt(row.value_enc);
    } catch (err) {
      logger.error({ err }, 'failed to decrypt api_key — regenerating');
      // fall through to regeneration: старая запись будет перезаписана ниже.
      db.prepare('DELETE FROM settings WHERE key = ?').run(SETTINGS_KEY);
    }
  }
  const fresh = randomUUID();
  insertStmt.run(SETTINGS_KEY, encrypt(fresh));
  logger.info({ api_key: fresh }, 'generated new API key (store this for the extension/UI)');
  return fresh;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Express middleware. Пропускает PUBLIC_PATHS; остальные требуют X-API-Key
 * либо ?api_key= в query.
 */
export function apiKeyMiddleware(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const expected = ensureApiKey();
  const provided = req.get('x-api-key') ?? req.query?.api_key;
  if (!provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}
