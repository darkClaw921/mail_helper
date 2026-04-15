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
  output_schema TEXT,
  is_default    INTEGER DEFAULT 0,
  enabled       INTEGER DEFAULT 1,
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
  enabled    INTEGER DEFAULT 1
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
  created_at          INTEGER,
  UNIQUE(account_id, uid)
);

CREATE INDEX IF NOT EXISTS messages_account_date
  ON messages(account_id, date DESC);

CREATE INDEX IF NOT EXISTS messages_unread
  ON messages(account_id, is_read);

-- Глобальные настройки (всегда шифруемые AES-GCM)
CREATE TABLE IF NOT EXISTS settings (
  key       TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL
);
