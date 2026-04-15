// accountManager.js — жизненный цикл ImapWorker'ов.
//
// * start() — читает все accounts с enabled=1 и поднимает для каждого ImapWorker.
//   Вызывается из server/index.js после того как сервер начал слушать порт.
// * reloadAccount(id) — ре-синхронизирует состояние одного аккаунта:
//     - если аккаунта нет в БД или enabled=0 — останавливает воркер;
//     - если worker уже есть — перезапускает (для применения новых кредов/folder);
//     - если worker отсутствует и enabled=1 — стартует.
//   Вызывается из api/accounts.js после POST/PUT/DELETE.
// * stopAll() — корректное закрытие всех воркеров при graceful shutdown.

import { db } from '../db/index.js';
import { logger } from '../logger.js';
import { ImapWorker } from './imapWorker.js';

const log = logger.child({ module: 'accountManager' });

/** @type {Map<number, ImapWorker>} */
const workers = new Map();

const selectAllEnabled = db.prepare(
  `SELECT id, label, email, imap_host, imap_port, imap_tls, imap_user, imap_pass_enc,
          smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass_enc, folder, enabled, initial_sync_count, initial_synced, created_at
     FROM accounts WHERE enabled = 1`,
);
const selectOne = db.prepare(
  `SELECT id, label, email, imap_host, imap_port, imap_tls, imap_user, imap_pass_enc,
          smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass_enc, folder, enabled, initial_sync_count, initial_synced, created_at
     FROM accounts WHERE id = ?`,
);

function canRunImap(account) {
  return (
    account &&
    account.enabled === 1 &&
    account.imap_host &&
    account.imap_port &&
    account.imap_user &&
    account.imap_pass_enc
  );
}

async function spawnWorker(account) {
  if (!canRunImap(account)) {
    log.warn({ account_id: account.id }, 'account not runnable (missing IMAP config)');
    return;
  }
  const worker = new ImapWorker(account);
  workers.set(account.id, worker);
  try {
    await worker.start();
    log.info({ account_id: account.id, email: account.email }, 'imap worker started');
  } catch (err) {
    log.error(
      { err: err?.message || String(err), account_id: account.id },
      'failed to start imap worker',
    );
  }
}

async function stopWorker(id) {
  const worker = workers.get(id);
  if (!worker) return;
  workers.delete(id);
  try {
    await worker.stop();
  } catch (err) {
    log.warn({ err: err?.message || String(err), account_id: id }, 'error stopping worker');
  }
}

/**
 * Поднять воркеры для всех enabled аккаунтов.
 * Вызывать один раз при старте сервера.
 */
export async function start() {
  const accounts = selectAllEnabled.all();
  log.info({ count: accounts.length }, 'starting imap workers');
  await Promise.all(accounts.map((acc) => spawnWorker(acc)));
}

/**
 * Перезапустить / остановить / стартовать воркер для одного аккаунта
 * согласно текущему состоянию в БД.
 * Вызывается из api/accounts.js после mutate.
 * @param {number} id — account id
 */
export async function reloadAccount(id) {
  const existing = workers.has(id);
  const account = selectOne.get(id);

  if (!account) {
    // Аккаунт удалён.
    if (existing) await stopWorker(id);
    return;
  }
  if (account.enabled !== 1 || !canRunImap(account)) {
    if (existing) await stopWorker(id);
    return;
  }

  if (existing) {
    // Перезапускаем с новыми кредами.
    await stopWorker(id);
  }
  await spawnWorker(account);
}

/**
 * Корректно закрыть все воркеры. Вызывать из graceful shutdown.
 */
export async function stopAll() {
  const ids = Array.from(workers.keys());
  log.info({ count: ids.length }, 'stopping all imap workers');
  await Promise.all(ids.map((id) => stopWorker(id)));
}

/**
 * Вспомогательное — получить воркер по id (для будущих фаз: mark_seen etc.).
 */
export function getWorker(id) {
  return workers.get(id) || null;
}
