// REST /api/stats — агрегирующие метрики для Dashboard.
// Один эндпоинт GET /api/stats, возвращает пачку COUNT(*)-значений за запрос
// через better-sqlite3 prepared statements. Авторизация — глобальный
// apiKeyMiddleware в webapp/server/index.js, локально не дублируем.

import { Router } from 'express';

import { db } from '../db/index.js';

const router = Router();

// Prepared statements — компилируются один раз при загрузке модуля.
const countTotalStmt = db.prepare('SELECT COUNT(*) AS n FROM messages');
const countImportantStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM messages WHERE is_important = 1',
);
const countCategorizedStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM messages WHERE classification_json IS NOT NULL',
);
const countPendingStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM messages WHERE is_read = 0 AND is_important = 1',
);
const countRulesActiveStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM actions WHERE enabled = 1',
);
// rules_triggered_today — прокси-метрика: письма с назначенным prompt_id
// (т. е. прошедшие через classifier-пайплайн) за сегодня по локальному дню.
// messages.created_at хранится в секундах (unix epoch).
const countRulesTriggeredTodayStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM messages " +
    "WHERE prompt_id IS NOT NULL " +
    "AND date(created_at, 'unixepoch', 'localtime') = date('now', 'localtime')",
);
// Суммарно потрачено LLM-токенов на классификацию писем.
const sumMessagesTokensStmt = db.prepare(
  'SELECT COALESCE(SUM(tokens_used), 0) AS n FROM messages',
);
const sumMessagesTokensTodayStmt = db.prepare(
  "SELECT COALESCE(SUM(tokens_used), 0) AS n FROM messages " +
    "WHERE date(created_at, 'unixepoch', 'localtime') = date('now', 'localtime')",
);
// Суммарно потрачено токенов по запускам действий.
const sumActionTokensStmt = db.prepare(
  'SELECT COALESCE(SUM(tokens_used), 0) AS n FROM action_runs',
);

router.get('/', (_req, res) => {
  const total = countTotalStmt.get()?.n ?? 0;
  const important = countImportantStmt.get()?.n ?? 0;
  const categorized = countCategorizedStmt.get()?.n ?? 0;
  const pending = countPendingStmt.get()?.n ?? 0;
  const rules_active = countRulesActiveStmt.get()?.n ?? 0;
  const rules_triggered_today = countRulesTriggeredTodayStmt.get()?.n ?? 0;
  const tokens_total = sumMessagesTokensStmt.get()?.n ?? 0;
  const tokens_today = sumMessagesTokensTodayStmt.get()?.n ?? 0;
  const action_tokens_total = sumActionTokensStmt.get()?.n ?? 0;

  res.json({
    total,
    important,
    categorized,
    pending,
    rules_active,
    rules_triggered_today,
    tokens_total,
    tokens_today,
    action_tokens_total,
  });
});

export default router;
