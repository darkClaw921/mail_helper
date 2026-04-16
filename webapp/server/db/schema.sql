-- Mail Helper SQLite schema
-- Applied idempotently on startup and via `npm run init-db`.

PRAGMA foreign_keys = ON;

-- Почтовые аккаунты (IMAP/SMTP)
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  imap_host     TEXT,
  imap_port     INTEGER,
  imap_tls      INTEGER DEFAULT 1,
  imap_user     TEXT,
  imap_pass_enc TEXT,
  smtp_host     TEXT,
  smtp_port     INTEGER,
  smtp_tls      INTEGER DEFAULT 1,
  smtp_user     TEXT,
  smtp_pass_enc TEXT,
  folder        TEXT    DEFAULT 'INBOX',
  enabled       INTEGER DEFAULT 1,
  initial_sync_count INTEGER,        -- null/0 = не синкать историю; -1 = всё; N>0 = последние N
  initial_synced     INTEGER DEFAULT 0, -- 1 после успешного первичного sync
  created_at    INTEGER
);

-- Промты-классификаторы для LLM
CREATE TABLE IF NOT EXISTS prompts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  system_prompt TEXT    NOT NULL,
  output_schema TEXT,                    -- raw JSON-schema (advanced override, optional)
  output_params TEXT,                    -- JSON-array of {key,type,description,required?}
  model         TEXT,
  is_default    INTEGER DEFAULT 0,
  enabled       INTEGER DEFAULT 1,
  match_mode    TEXT    NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all','first')),
  created_at    INTEGER
);

-- Действия по результату классификации
CREATE TABLE IF NOT EXISTS actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT,
  prompt_id  INTEGER REFERENCES prompts(id) ON DELETE SET NULL,
  match_expr TEXT    NOT NULL,
  type       TEXT    NOT NULL,  -- telegram|webhook|forward|browser
  config_enc TEXT    NOT NULL,
  enabled    INTEGER DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 0 -- выше = раньше в порядке выполнения (ORDER BY priority DESC, id ASC)
);

-- Письма: уже принятые и разобранные
CREATE TABLE IF NOT EXISTS messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  uid                 INTEGER NOT NULL,
  message_id          TEXT,
  subject             TEXT,
  from_addr           TEXT,
  to_addr             TEXT,
  date                INTEGER,
  snippet             TEXT,
  body_text           TEXT,
  body_html           TEXT,
  is_read             INTEGER DEFAULT 0,
  is_important        INTEGER DEFAULT 0,
  classification_json TEXT,
  prompt_id           INTEGER,
  tokens_used         INTEGER,                   -- total_tokens от LLM классификации
  cost                REAL,                      -- стоимость классификации в USD (из OpenRouter usage.cost)
  created_at          INTEGER,
  UNIQUE(account_id, uid)
);

CREATE INDEX IF NOT EXISTS messages_account_date
  ON messages(account_id, date DESC);

CREATE INDEX IF NOT EXISTS messages_unread
  ON messages(account_id, is_read);

-- Журнал запусков действий (action). Пишется в runner.js после matched dispatch.
-- tokens_used берётся из messages.tokens_used на момент запуска (LLM-стоимость
-- классификации письма, которое триггернуло action).
CREATE TABLE IF NOT EXISTS action_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id    INTEGER NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  message_id   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  ok           INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  tokens_used  INTEGER,
  cost         REAL,                      -- стоимость LLM-классификации в USD (per-prompt, из OpenRouter usage.cost)
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS action_runs_action_id ON action_runs(action_id);
CREATE INDEX IF NOT EXISTS action_runs_created_at ON action_runs(created_at DESC);

-- Глобальные настройки (всегда шифруемые AES-GCM)
CREATE TABLE IF NOT EXISTS settings (
  key       TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL
);
