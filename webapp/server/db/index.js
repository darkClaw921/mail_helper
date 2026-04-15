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
//
// В поле system_prompt храним ТОЛЬКО пользовательскую бизнес-логику. Формат входа
// (subject/from/body) и JSON-контракт ответа добавляются автоматически в
// classifier.composeSystemPrompt() перед вызовом LLM.
const DEFAULT_PROMPT_NAME = 'Default Importance Classifier';
const DEFAULT_PROMPT_SYSTEM =
  'Важным считай: счета, безопасность, дедлайны, личные обращения, явные действия.';
// output_schema опционален: если null — используется контракт, построенный из output_params
// в classifier.composeSystemPrompt(). Оставляем null, чтобы не зашивать raw-schema в seed.
const DEFAULT_PROMPT_SCHEMA = null;
// Параметры ответа LLM по умолчанию. Это же whitelist-идентификаторы для match_expr
// действий, привязанных к этому промту. Пользователь может добавить свои поля в UI.
const DEFAULT_PROMPT_OUTPUT_PARAMS = JSON.stringify([
  {
    key: 'important',
    type: 'boolean',
    description: 'Важное ли письмо',
    required: true,
  },
  {
    key: 'reason',
    type: 'string',
    description: 'Краткая причина на русском (<=140 символов)',
    required: true,
  },
  {
    key: 'tags',
    type: 'string[]',
    description: 'Теги: work|personal|bill|security|spam|other',
    required: true,
  },
  {
    key: 'summary',
    type: 'string',
    description: '1-2 предложения сути письма',
    required: true,
  },
]);

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
  const promptsCols = db.prepare("PRAGMA table_info('prompts')").all().map((r) => r.name);
  if (!promptsCols.includes('model')) {
    db.exec('ALTER TABLE prompts ADD COLUMN model TEXT');
  }
  if (!promptsCols.includes('output_params')) {
    db.exec('ALTER TABLE prompts ADD COLUMN output_params TEXT');
  }
  const messagesCols = db.prepare("PRAGMA table_info('messages')").all().map((r) => r.name);
  if (!messagesCols.includes('tokens_used')) {
    db.exec('ALTER TABLE messages ADD COLUMN tokens_used INTEGER');
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
    `INSERT INTO prompts (name, system_prompt, output_schema, output_params, is_default, enabled, created_at)
     VALUES (@name, @system_prompt, @output_schema, @output_params, 1, 1, @created_at)`,
  ).run({
    name: DEFAULT_PROMPT_NAME,
    system_prompt: DEFAULT_PROMPT_SYSTEM,
    output_schema: DEFAULT_PROMPT_SCHEMA,
    output_params: DEFAULT_PROMPT_OUTPUT_PARAMS,
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
