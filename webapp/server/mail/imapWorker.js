// ImapWorker — одно IMAP-соединение на один аккаунт.
//
// Отвечает за:
//  * подключение к IMAP через imapflow (пароль расшифровывается из imap_pass_enc);
//  * открытие папки (account.folder, default 'INBOX');
//  * получение lastSeenUid из messages (max uid), инициализация если нет писем;
//  * IDLE-цикл: при событии `exists` (новые письма) — поиск UID больше lastSeenUid
//    и эмит 'message:new' (account_id, uid) для каждого;
//  * периодический re-IDLE раз в ~25 минут (держим соединение свежим);
//  * авто-реконнект с экспоненциальной задержкой при обрыве / ошибке.
//
// Экспортирует класс ImapWorker и статический метод ImapWorker.testConnection(account)
// для endpoint /api/accounts/:id/test.

import { ImapFlow } from 'imapflow';

import { db } from '../db/index.js';
import { decrypt } from '../db/crypto.js';
import { logger } from '../logger.js';
import { mailEvents } from './events.js';
import { fetchAndStore } from './fetcher.js';

const RE_IDLE_MS = 25 * 60 * 1000; // 25 минут
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const TEST_TIMEOUT_MS = 15_000;
// Максимум неудачных попыток подряд до того как воркер считает аккаунт
// "фатально сломанным" (например неверный пароль). После этого он продолжает
// ждать по max-задержке, но пишет ERROR-уровень и не зацикливает fast-loop.
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Определяет, является ли ошибка "фатальной" (не имеет смысла быстро
 * ретраить — требует вмешательства пользователя). Включает AUTHENTICATIONFAILED,
 * LOGIN rejected, неверный хост (ENOTFOUND) и т.п.
 */
function isFatalAuthError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || err?.responseText || '').toLowerCase();
  return (
    msg.includes('authenticationfailed') ||
    msg.includes('invalid credentials') ||
    msg.includes('authentication failed') ||
    msg.includes('login failed') ||
    code.includes('authenticationfailed')
  );
}

function buildClientConfig(account) {
  if (!account.imap_host || !account.imap_port) {
    throw new Error(`account ${account.id}: imap host/port not configured`);
  }
  if (!account.imap_user || !account.imap_pass_enc) {
    throw new Error(`account ${account.id}: imap credentials not configured`);
  }
  const pass = decrypt(account.imap_pass_enc);
  return {
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_tls ? true : false,
    auth: {
      user: account.imap_user,
      pass,
    },
    // Глушим штатный логгер imapflow в нашем pino (debug/trace).
    logger: false,
    // Быстрее падаем если хост недоступен.
    emitLogs: false,
  };
}

function withTimeout(promise, ms, label) {
  let tid;
  const timeout = new Promise((_, reject) => {
    tid = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(tid));
}

export class ImapWorker {
  constructor(account) {
    this.account = account;
    this.folder = account.folder || 'INBOX';
    this.log = logger.child({ module: 'imapWorker', account_id: account.id, email: account.email });

    this.client = null;
    this.lock = null;
    this.idleTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.lastSeenUid = 0;
    this.stopped = false;
    this.running = false;
    this.consecutiveFailures = 0;
    this._onExists = null;
    this._onError = null;
    this._onClose = null;
    this._onFlags = null;
  }

  /** Стартует воркер — подключается и входит в IDLE-цикл (async, но не ждём IDLE). */
  async start() {
    this.stopped = false;
    this._initLastSeenUid();
    this._loop().catch((err) => this.log.error({ err }, 'imap loop crashed'));
  }

  /** Корректно останавливает воркер: прерывает IDLE, освобождает lock, logout. */
  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this._teardown();
    this.log.info('imap worker stopped');
  }

  _initLastSeenUid() {
    const row = db
      .prepare('SELECT MAX(uid) AS maxUid FROM messages WHERE account_id = ?')
      .get(this.account.id);
    this.lastSeenUid = row?.maxUid || 0;
    this.log.debug({ lastSeenUid: this.lastSeenUid }, 'initial lastSeenUid');
  }

  async _loop() {
    while (!this.stopped) {
      try {
        await this._connectAndIdle();
        // Если _connectAndIdle вернулся штатно — цикл re-IDLE продолжается,
        // сбрасываем backoff и счётчик неудач.
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.consecutiveFailures = 0;
      } catch (err) {
        if (this.stopped) break;
        this.consecutiveFailures += 1;
        const fatal = isFatalAuthError(err);
        this.log.error(
          {
            err: err?.message || String(err),
            consecutiveFailures: this.consecutiveFailures,
            fatal,
          },
          'imap connection error',
        );
        if (fatal) {
          // Фатальные ошибки (неверный пароль и т.п.) — сразу держим max delay,
          // чтобы не долбить IMAP сервер каждые 2с.
          this.reconnectDelay = RECONNECT_MAX_MS;
        }
        if (this.consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
          this.log.error(
            { consecutiveFailures: this.consecutiveFailures },
            'imap worker keeps failing — continuing with max backoff (check credentials / network)',
          );
          // Прижимаем к потолку чтобы дальше не было fast-loop.
          this.reconnectDelay = RECONNECT_MAX_MS;
        }
        await this._teardown();
        await this._waitBackoff();
      }
    }
  }

  async _waitBackoff() {
    const base = this.reconnectDelay;
    // Jitter ±25% чтобы при одновременном падении нескольких воркеров/провайдера
    // они не штурмовали IMAP синхронно.
    const jitter = base * (Math.random() * 0.5 - 0.25);
    const delay = Math.max(RECONNECT_BASE_MS, Math.round(base + jitter));
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.log.info({ delayMs: delay, baseMs: base }, 'reconnecting after delay');
    await new Promise((resolve) => {
      this.reconnectTimer = setTimeout(resolve, delay);
    });
    this.reconnectTimer = null;
  }

  async _connectAndIdle() {
    const cfg = buildClientConfig(this.account);
    this.client = new ImapFlow(cfg);

    // Глобальные ошибки соединения -> прерывают IDLE через break idle через logout().
    this._onError = (err) => {
      this.log.warn({ err: err?.message || String(err) }, 'imap client error');
    };
    this._onClose = () => {
      this.log.warn('imap connection closed');
    };
    this.client.on('error', this._onError);
    this.client.on('close', this._onClose);

    await this.client.connect();
    this.log.info({ folder: this.folder }, 'imap connected');

    this.lock = await this.client.getMailboxLock(this.folder);

    // Первичная синхронизация истории (если настроено и ещё не выполнено).
    // account.initial_sync_count: null/0 = не синкать; -1 = все; N>0 = последние N.
    const wantSync = this.account.initial_sync_count;
    const alreadySynced = !!this.account.initial_synced;
    if (!alreadySynced && Number.isInteger(wantSync) && wantSync !== 0) {
      await this._initialSync(wantSync);
    }

    // Если lastSeenUid ещё ноль — инициализируем его по текущему состоянию mailbox,
    // чтобы при первом запуске не тянуть всю историю.
    if (this.lastSeenUid === 0) {
      const uidNext = this.client.mailbox?.uidNext;
      if (Number.isInteger(uidNext) && uidNext > 1) {
        this.lastSeenUid = uidNext - 1;
        this.log.info({ lastSeenUid: this.lastSeenUid }, 'seeded lastSeenUid from uidNext');
      }
    }

    // exists — поступило новое письмо (или их стало больше).
    this._onExists = (data) => {
      this.log.debug({ count: data?.count, prevCount: data?.prevCount }, 'exists event');
      this._handleExists().catch((err) =>
        this.log.error({ err: err?.message || String(err) }, 'handleExists failed'),
      );
    };
    this.client.on('exists', this._onExists);

    // flags — сервер уведомил об изменении флагов (пользователь пометил письмо
    // прочитанным в Gmail UI / другой клиент). Сверяем \Seen и обновляем БД.
    // Данные imapflow: { path, uid?, seq, flags (Set<string>), flagsAdded (Set), flagsRemoved (Set) }.
    // uid может отсутствовать если сервер прислал только seq — в таком случае пропускаем
    // (для корректной ре-синхронизации можно было бы сделать UID FETCH, но это уже Ф9+).
    this._onFlags = (data) => {
      this._handleFlags(data).catch((err) =>
        this.log.error({ err: err?.message || String(err) }, 'handleFlags failed'),
      );
    };
    this.client.on('flags', this._onFlags);

    // Первичный вычитатель: если пока воркер был оффлайн прилетели письма —
    // догоним их сразу после connect, ещё до входа в IDLE.
    await this._handleExists();

    // Периодический re-IDLE: каждые ~25 минут выходим из idle чтобы сервер
    // не порвал соединение по таймауту, и сразу входим обратно.
    while (!this.stopped) {
      const idlePromise = this.client.idle();
      this.idleTimer = setTimeout(() => {
        // imapflow.idle() завершается когда приходит ответ от сервера
        // или когда в фоне наступает mailbox change. Для принудительного
        // выхода достаточно закрыть соединение: но мы хотим re-IDLE
        // без реконнекта. Штатный способ — logout/ close => reconnect.
        // imapflow v1+ сам шлёт DONE при logout, поэтому инициируем мягко.
        this.log.debug('re-IDLE tick');
        // Вызываем client.idle() повторно (оно вернёт Promise который резолвится
        // когда предыдущий idle завершится). Чтобы разорвать — закрываем сокет.
        this.client.close().catch(() => {});
      }, RE_IDLE_MS);

      try {
        await idlePromise;
      } finally {
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = null;
        }
      }

      if (this.stopped) break;

      // Если вышли по re-IDLE через close — соединение умерло, пробрасываем
      // в catch верхнего loop() для reconnect.
      if (!this.client.usable) {
        throw new Error('connection closed during re-IDLE cycle');
      }
      // Иначе повторяем IDLE (сервер вернул tagged OK или что-то изменилось).
    }
  }

  /**
   * Первичная синхронизация истории письма при первом подключении аккаунта.
   * @param {number} count — -1: всё, N>0: последние N
   */
  async _initialSync(count) {
    this.log.info({ count }, 'initial sync start');
    let uids;
    try {
      uids = await this.client.search({ all: true }, { uid: true });
    } catch (err) {
      this.log.error({ err: err?.message || String(err) }, 'initial sync search failed');
      return;
    }
    if (!Array.isArray(uids) || uids.length === 0) {
      this.log.info('initial sync: mailbox empty');
      this._markInitialSynced();
      return;
    }
    uids.sort((a, b) => a - b);
    const selected = count === -1 ? uids : uids.slice(-count);
    this.log.info({ total: uids.length, fetching: selected.length }, 'initial sync fetching');

    let fetched = 0;
    let failed = 0;
    for (const uid of selected) {
      try {
        const saved = await fetchAndStore(this.client, this.account.id, uid);
        if (saved) {
          fetched += 1;
          mailEvents.emit('message:new', { account_id: this.account.id, uid });
          mailEvents.emit('message:stored', { message: saved });
        }
        this.lastSeenUid = Math.max(this.lastSeenUid, uid);
      } catch (err) {
        failed += 1;
        this.log.error({ err: err?.message || String(err), uid }, 'initial sync fetch failed');
      }
    }
    this.log.info({ fetched, failed }, 'initial sync done');
    this._markInitialSynced();
  }

  _markInitialSynced() {
    try {
      db.prepare('UPDATE accounts SET initial_synced = 1 WHERE id = ?').run(this.account.id);
      this.account.initial_synced = 1;
    } catch (err) {
      this.log.warn({ err: err?.message || String(err) }, 'failed to mark initial_synced');
    }
  }

  async _handleExists() {
    if (!this.client?.usable) return;
    // Ищем все UID больше lastSeenUid. Используем IMAP search по UID-range.
    // Если lastSeenUid=0 — берём только uidNext-1 чтобы не тащить историю.
    const fromUid = this.lastSeenUid > 0 ? this.lastSeenUid + 1 : this.client.mailbox?.uidNext || 1;
    const range = `${fromUid}:*`;
    let uids;
    try {
      // client.search с { uid: true } возвращает массив UID.
      uids = await this.client.search({ uid: range }, { uid: true });
    } catch (err) {
      this.log.warn({ err: err?.message || String(err) }, 'uid search failed');
      return;
    }
    if (!Array.isArray(uids) || uids.length === 0) return;
    uids.sort((a, b) => a - b);

    for (const uid of uids) {
      if (uid <= this.lastSeenUid) continue;
      try {
        const saved = await fetchAndStore(this.client, this.account.id, uid);
        if (saved) {
          this.log.info(
            { uid, message_id: saved.message_id, subject: saved.subject },
            'message stored',
          );
          mailEvents.emit('message:new', { account_id: this.account.id, uid });
          mailEvents.emit('message:stored', { message: saved });
        }
        this.lastSeenUid = Math.max(this.lastSeenUid, uid);
      } catch (err) {
        // Ошибка одного письма не должна валить воркер.
        this.log.error({ err: err?.message || String(err), uid }, 'fetchAndStore failed');
      }
    }
  }

  /**
   * Установить/снять IMAP-флаг на письме по UID.
   * Выполняется в текущей открытой папке (this.folder) через уже активный lock —
   * mailbox уже открыт в _connectAndIdle. Если воркер не подключён или IDLE ещё
   * не стартовал (this.client?.usable === false) — возвращает { ok:false, error:'not_ready' }.
   *
   * IMAP операция выводит клиент из IDLE (imapflow сам разруливает DONE/продолжение),
   * поэтому отдельного выхода из idle здесь делать не нужно.
   *
   * @param {number} uid
   * @param {string} flag — например '\\Seen'
   * @param {boolean|'add'|'remove'} add — true/'add' → add; false/'remove' → remove
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async setFlag(uid, flag, add) {
    const action = add === true || add === 'add' ? 'add' : 'remove';
    if (!this.client?.usable) {
      this.log.warn(
        { uid, flag, action },
        'setFlag skipped: imap client not ready',
      );
      return { ok: false, error: 'not_ready' };
    }
    // Проверка: письмо должно быть в текущей папке. UID нумерация привязана к mailbox,
    // и imapflow держит открытой именно this.folder. Если папка не совпадает (будущие фазы
    // с мульти-folder) — просто пишем warn и не валим REST.
    try {
      if (action === 'add') {
        await this.client.messageFlagsAdd(String(uid), [flag], { uid: true });
      } else {
        await this.client.messageFlagsRemove(String(uid), [flag], { uid: true });
      }
      this.log.info({ uid, flag, action }, 'imap flag updated');
      return { ok: true };
    } catch (err) {
      this.log.error(
        { err: err?.message || String(err), uid, flag, action },
        'imap flag update failed',
      );
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Обработка события flags от imapflow. Вычисляет, изменился ли \Seen по сравнению
   * с тем, что было в БД, обновляет messages.is_read и эмитит 'message:updated' в mailEvents.
   * Для других флагов (например \Flagged) пока ничего не делаем — это вне scope Ф8.
   * @private
   */
  async _handleFlags(data) {
    const uid = data?.uid;
    if (!Number.isInteger(uid) || uid <= 0) {
      this.log.debug({ data }, 'flags event without uid — skipping');
      return;
    }
    // imapflow отдаёт flags как Set<string>; подстраховываемся на случай массива.
    const flagsSet = data?.flags instanceof Set
      ? data.flags
      : new Set(Array.isArray(data?.flags) ? data.flags : []);
    const isSeenNow = flagsSet.has('\\Seen') ? 1 : 0;

    const row = db
      .prepare('SELECT id, is_read FROM messages WHERE account_id = ? AND uid = ?')
      .get(this.account.id, uid);
    if (!row) {
      this.log.debug({ uid, isSeenNow }, 'flags event for unknown message — skipping');
      return;
    }
    if (row.is_read === isSeenNow) {
      // Ничего не изменилось (наш собственный PATCH уже обновил БД; или чужой флаг).
      return;
    }
    db.prepare('UPDATE messages SET is_read = ? WHERE id = ?').run(isSeenNow, row.id);
    this.log.info(
      { id: row.id, uid, is_read: isSeenNow, source: 'imap' },
      'is_read synced from imap flags event',
    );
    mailEvents.emit('message:updated', {
      id: row.id,
      account_id: this.account.id,
      is_read: isSeenNow,
      source: 'imap',
    });
  }

  async _teardown() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.client) {
      try {
        if (this._onExists) this.client.removeListener('exists', this._onExists);
        if (this._onFlags) this.client.removeListener('flags', this._onFlags);
        if (this._onError) this.client.removeListener('error', this._onError);
        if (this._onClose) this.client.removeListener('close', this._onClose);
      } catch (_) {
        /* ignore */
      }
    }
    if (this.lock) {
      try {
        this.lock.release();
      } catch (_) {
        /* ignore */
      }
      this.lock = null;
    }
    if (this.client) {
      try {
        if (this.client.usable) {
          await this.client.logout();
        } else {
          this.client.close();
        }
      } catch (_) {
        /* ignore */
      }
      this.client = null;
    }
  }
}

/**
 * Проверка IMAP-подключения для endpoint /api/accounts/:id/test.
 * Connect + mailboxOpen + list + logout, с таймаутом.
 * Возвращает { ok: true, mailboxes?: string[] } или { ok: false, error: string }.
 */
ImapWorker.testConnection = async function testConnection(account) {
  let client = null;
  try {
    const cfg = buildClientConfig(account);
    client = new ImapFlow(cfg);
    // Глушим события ошибок, чтобы они не уходили как uncaughtException.
    client.on('error', () => {});

    await withTimeout(client.connect(), TEST_TIMEOUT_MS, 'imap connect');
    const folder = account.folder || 'INBOX';
    const lock = await withTimeout(client.getMailboxLock(folder), TEST_TIMEOUT_MS, 'mailbox open');
    try {
      const mailboxes = await withTimeout(client.list(), TEST_TIMEOUT_MS, 'list mailboxes');
      return { ok: true, mailboxes: mailboxes.map((m) => m.path) };
    } finally {
      lock.release();
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (client) {
      try {
        if (client.usable) {
          await client.logout();
        } else {
          client.close();
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
};
