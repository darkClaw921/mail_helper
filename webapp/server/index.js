// Express bootstrap: config, логгер, БД, /api/health, graceful shutdown.
// Монтирует все CRUD-роуты /api (settings, accounts, prompts, actions, messages).
// Поверх того же http.Server поднимается WebSocket-хаб на /ws.

import { createServer } from 'node:http';

import express from 'express';
import { pinoHttp } from 'pino-http';

import { config } from './config.js';
import { logger } from './logger.js';
import { db, closeDb } from './db/index.js';
import { apiKeyMiddleware, ensureApiKey } from './api/auth.js';
import * as accountManager from './mail/accountManager.js';
import { registerClassifierPipeline } from './llm/pipeline.js';
import { registerActionsRunner } from './actions/runner.js';
import { initWsHub } from './ws/hub.js';

import settingsRouter from './api/settings.js';
import accountsRouter from './api/accounts.js';
import promptsRouter from './api/prompts.js';
import actionsRouter from './api/actions.js';
import messagesRouter from './api/messages.js';

const PKG_VERSION = '0.1.0';
const STARTED_AT = Date.now();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    version: PKG_VERSION,
  });
});

// Всё под /api/* (кроме health) требует X-API-Key.
app.use('/api', apiKeyMiddleware);

// CRUD-роуты.
app.use('/api/settings', settingsRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/prompts', promptsRouter);
app.use('/api/actions', actionsRouter);
app.use('/api/messages', messagesRouter);

// 404 для неизвестных /api/* роутов.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Централизованный error handler — чтобы необработанные ошибки не рушили процесс молча.
// В логах — полный stack (через err-сериализатор pino); клиент получает только
// { error: code, message? } без stack trace и без внутренностей.
app.use((err, req, res, _next) => {
  (req.log || logger).error({ err }, 'unhandled request error');
  if (res.headersSent) return;
  const status = Number.isInteger(err?.status) ? err.status : 500;
  // 4xx — это "чистые" ошибки валидации/авторизации, их message безопасно отдать.
  // 5xx — возможно протекание деталей БД/SQL/stack, поэтому обобщаем.
  const safeMessage =
    status >= 500
      ? 'internal error'
      : typeof err?.message === 'string'
        ? err.message
        : 'error';
  res.status(status).json({
    error: err?.code || (status >= 500 ? 'internal_error' : 'error'),
    message: safeMessage,
  });
});

// Убеждаемся что api_key существует (генерируется и логируется при первом старте).
ensureApiKey();

// Подписываем classifier-pipeline на mailEvents.'message:stored' до старта IMAP-воркеров,
// чтобы ни одно новое письмо не прошло мимо классификации.
registerClassifierPipeline();

// Подписываем actions-runner на mailEvents.'message:classified' — он будет
// прогонять enabled actions (telegram/webhook/forward/browser) с учётом match_expr.
// Регистрируем ДО старта IMAP, чтобы не упустить ни одно классифицированное письмо.
registerActionsRunner();

// Создаём http.Server явно (а не app.listen()) чтобы повесить на него WS upgrade.
const server = createServer(app);

// WS-хаб поднимается ДО listen — успеет навесить 'upgrade'-хендлер до первого коннекта.
const wsHub = initWsHub(server);

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    logger.fatal({ port: config.PORT }, `port ${config.PORT} already in use — set PORT in webapp/.env to a free port`);
  } else {
    logger.fatal({ err }, 'http server error');
  }
  process.exit(1);
});

server.listen(config.PORT, () => {
  logger.info({ port: config.PORT, dbPath: config.DB_PATH }, 'mail-helper backend listening');
  // Тач БД чтобы не было предупреждения о неиспользуемом импорте и убедиться что коннект жив.
  const count = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get();
  logger.debug({ tables: count?.n }, 'sqlite ready');

  // Поднимаем IMAP-воркеры для всех enabled аккаунтов. Не ждём — старт
  // воркеров не блокирует HTTP-сервер, ошибки каждого воркера хендлятся внутри.
  accountManager
    .start()
    .catch((err) => logger.error({ err: err?.message || String(err) }, 'accountManager.start failed'));
});

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');

  // Гасим IMAP-воркеры параллельно с закрытием HTTP-сервера.
  const stopWorkersPromise = accountManager.stopAll().catch((err) =>
    logger.error({ err: err?.message || String(err) }, 'accountManager.stopAll failed'),
  );

  // Закрываем все WS-соединения корректным close-frame'ом. server.close()
  // не дождётся upgrade-сокетов сам, поэтому wsHub.close() обязателен ДО.
  const stopWsPromise = wsHub
    .close()
    .catch((err) => logger.error({ err: err?.message || String(err) }, 'wsHub.close failed'));

  const finish = async (err) => {
    if (err) logger.error({ err }, 'http close error');
    await stopWorkersPromise;
    await stopWsPromise;
    try { closeDb(); } catch (_) { /* ignore */ }
    logger.info('bye');
    process.exit(err ? 1 : 0);
  };
  if (server.listening) {
    server.close(finish);
  } else {
    finish();
  }
  // страховка: если server.close висит — принудительно через 5с
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  shutdown('uncaughtException');
});

export { app, server, wsHub };
