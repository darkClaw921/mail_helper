// REST /api/stats — агрегирующие метрики для Dashboard.
// GET /api/stats — пачка COUNT/SUM значений + реальная стоимость из OpenRouter.
// POST /api/stats/reset-tokens — сброс счётчиков токенов и стоимости.
// Авторизация — глобальный apiKeyMiddleware в webapp/server/index.js.

import { Router } from 'express';

import { db } from '../db/index.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'stats' });
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
const countRulesTriggeredTodayStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM messages " +
    "WHERE prompt_id IS NOT NULL " +
    "AND date(created_at, 'unixepoch', 'localtime') = date('now', 'localtime')",
);
const sumMessagesTokensStmt = db.prepare(
  'SELECT COALESCE(SUM(tokens_used), 0) AS n FROM messages',
);
const sumMessagesTokensTodayStmt = db.prepare(
  "SELECT COALESCE(SUM(tokens_used), 0) AS n FROM messages " +
    "WHERE date(created_at, 'unixepoch', 'localtime') = date('now', 'localtime')",
);
const sumActionTokensStmt = db.prepare(
  'SELECT COALESCE(SUM(tokens_used), 0) AS n FROM action_runs',
);

// Реальная стоимость LLM из OpenRouter (usage.cost), хранится в messages.cost.
const sumCostStmt = db.prepare(
  'SELECT COALESCE(SUM(cost), 0) AS n FROM messages',
);
const sumCostTodayStmt = db.prepare(
  "SELECT COALESCE(SUM(cost), 0) AS n FROM messages " +
    "WHERE date(created_at, 'unixepoch', 'localtime') = date('now', 'localtime')",
);

// Настройки валюты — plain text из settings.
const selectSettingStmt = db.prepare('SELECT value_enc FROM settings WHERE key = ?');

function getCurrencySettings() {
  const currency = selectSettingStmt.get('currency')?.value_enc || 'USD';
  const rate = parseFloat(selectSettingStmt.get('currency_rate')?.value_enc) || null;
  return { currency, rate };
}

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
  const cost_usd = sumCostStmt.get()?.n ?? 0;
  const cost_today_usd = sumCostTodayStmt.get()?.n ?? 0;
  const { currency, rate } = getCurrencySettings();

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
    cost_usd: Math.round(cost_usd * 1_000_000) / 1_000_000,
    cost_today_usd: Math.round(cost_today_usd * 1_000_000) / 1_000_000,
    currency,
    currency_rate: rate,
  });
});

// POST /api/stats/reset-tokens — сброс всех счётчиков токенов и стоимости.
const resetMessagesTokensStmt = db.prepare('UPDATE messages SET tokens_used = NULL, cost = NULL');
const deleteActionRunsStmt = db.prepare('DELETE FROM action_runs');

router.post('/reset-tokens', (_req, res) => {
  const tx = db.transaction(() => {
    const msgInfo = resetMessagesTokensStmt.run();
    const arInfo = deleteActionRunsStmt.run();
    return { messages_updated: msgInfo.changes, action_runs_deleted: arInfo.changes };
  });
  const result = tx();
  log.info(result, 'token stats reset');
  res.json({ ok: true, ...result });
});

export default router;
