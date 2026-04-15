// better-sqlite3 wrapper. Opens DB at config.DB_PATH, applies schema.sql if needed,
// exposes the db instance and a couple of helpers.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

// Дефолтный промт-классификатор. Сидится ровно один раз при первом запуске
// (если в таблице prompts ещё нет ни одной записи).
const DEFAULT_PROMPT_NAME = 'Default Importance Classifier';
const DEFAULT_PROMPT_SYSTEM = `Ты — классификатор электронной почты. На вход получаешь subject, from, body.
Верни СТРОГО JSON:
{
  "important": boolean,
  "reason": "краткая причина на русском (<=140 символов)",
  "tags": ["work"|"personal"|"bill"|"security"|"spam"|"other", ...],
  "summary": "1-2 предложения сути письма"
}
Важным считай: счета, безопасность, дедлайны, личные обращения, явные действия.`;
const DEFAULT_PROMPT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    important: { type: 'boolean' },
    reason: { type: 'string', maxLength: 140 },
    tags: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['important', 'reason', 'tags', 'summary'],
});

function openDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function applySchema(db) {
  const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);
  // Миграции для существующих БД (SQLite не умеет ADD COLUMN IF NOT EXISTS).
  const existing = db.prepare("PRAGMA table_info('accounts')").all().map((r) => r.name);
  if (!existing.includes('initial_sync_count')) {
    db.exec('ALTER TABLE accounts ADD COLUMN initial_sync_count INTEGER');
  }
  if (!existing.includes('initial_synced')) {
    db.exec('ALTER TABLE accounts ADD COLUMN initial_synced INTEGER DEFAULT 0');
  }
}

/**
 * Сидит дефолтный промт-классификатор, если таблица prompts пуста.
 * Идемпотентно: повторные вызовы не создают дубликатов.
 * Вызывается автоматически после applySchema().
 */
export function seedDefaultPrompt(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM prompts').get();
  if (row && row.n > 0) return;
  db.prepare(
    `INSERT INTO prompts (name, system_prompt, output_schema, is_default, enabled, created_at)
     VALUES (@name, @system_prompt, @output_schema, 1, 1, @created_at)`,
  ).run({
    name: DEFAULT_PROMPT_NAME,
    system_prompt: DEFAULT_PROMPT_SYSTEM,
    output_schema: DEFAULT_PROMPT_SCHEMA,
    created_at: Math.floor(Date.now() / 1000),
  });
}

const dbPath = resolve(process.cwd(), config.DB_PATH);
export const db = openDatabase(dbPath);
applySchema(db);
seedDefaultPrompt(db);

export function closeDb() {
  try {
    db.close();
  } catch {
    // ignore double-close
  }
}
