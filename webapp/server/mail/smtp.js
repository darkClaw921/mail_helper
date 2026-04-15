// smtp.js — обёртка над nodemailer для отправки писем от имени почтового аккаунта.
//
// Использование:
//   import { sendMail, forwardMessage, testSmtp } from './mail/smtp.js';
//   await sendMail(accountId, { to, subject, text, html });
//   await forwardMessage(accountId, messageId, to);
//
// Transporter создаётся на каждый вызов (без кэша в MVP) — cheap и не держим лишних
// сокетов. Пароли расшифровываем прямо здесь из smtp_pass_enc.

import nodemailer from 'nodemailer';

import { db } from '../db/index.js';
import { decrypt } from '../db/crypto.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'smtp' });

const TEST_TIMEOUT_MS = 15_000;

const selectAccount = db.prepare(
  `SELECT id, label, email, smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass_enc
     FROM accounts WHERE id = ?`,
);
const selectMessage = db.prepare(
  `SELECT id, account_id, subject, from_addr, to_addr, date, body_text, body_html
     FROM messages WHERE id = ?`,
);

function buildTransport(account) {
  if (!account) throw new Error('smtp: account not found');
  if (!account.smtp_host || !account.smtp_port) {
    throw new Error(`smtp: account ${account.id} has no SMTP host/port`);
  }
  const options = {
    host: account.smtp_host,
    port: account.smtp_port,
    secure: !!account.smtp_tls && Number(account.smtp_port) === 465,
    requireTLS: !!account.smtp_tls && Number(account.smtp_port) !== 465,
  };
  if (account.smtp_user && account.smtp_pass_enc) {
    options.auth = {
      user: account.smtp_user,
      pass: decrypt(account.smtp_pass_enc),
    };
  }
  return nodemailer.createTransport(options);
}

function withTimeout(promise, ms, label) {
  let tid;
  const timeout = new Promise((_, reject) => {
    tid = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(tid));
}

/**
 * Отправить письмо от имени аккаунта.
 * @param {number} accountId
 * @param {{ to: string|string[], subject: string, text?: string, html?: string,
 *           cc?: string|string[], bcc?: string|string[], replyTo?: string,
 *           attachments?: any[] }} message
 * @returns {Promise<{ messageId: string, envelope: object }>}
 */
export async function sendMail(accountId, message) {
  const account = selectAccount.get(accountId);
  if (!account) throw new Error(`smtp: account ${accountId} not found`);
  const transporter = buildTransport(account);
  try {
    const from = message.from || `${account.label || ''} <${account.email}>`.trim();
    const info = await transporter.sendMail({ ...message, from });
    log.info(
      { account_id: accountId, messageId: info.messageId, to: message.to },
      'smtp sendMail ok',
    );
    return info;
  } finally {
    transporter.close();
  }
}

/**
 * Переслать сохранённое письмо на указанный адрес.
 * Используется из actions/forward.js (Фаза 5).
 * @param {number} accountId
 * @param {number} messageId — id строки из таблицы messages
 * @param {string|string[]} to
 * @param {{ subjectPrefix?: string }} [opts]
 */
export async function forwardMessage(accountId, messageId, to, opts = {}) {
  const msg = selectMessage.get(messageId);
  if (!msg) throw new Error(`smtp: message ${messageId} not found`);

  const prefix = opts.subjectPrefix ?? 'Fwd: ';
  const subject = `${prefix}${msg.subject || ''}`.trim();

  // Простая пересылка: добавляем заголовок "From / Date / Subject" перед телом.
  const headerBlock = [
    msg.from_addr ? `From: ${msg.from_addr}` : null,
    msg.date ? `Date: ${new Date(msg.date).toUTCString()}` : null,
    msg.to_addr ? `To: ${msg.to_addr}` : null,
    msg.subject ? `Subject: ${msg.subject}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const text = [
    '---------- Forwarded message ----------',
    headerBlock,
    '',
    msg.body_text || '',
  ].join('\n');

  const html = msg.body_html
    ? `<div>---------- Forwarded message ----------<br>${headerBlock.replace(/\n/g, '<br>')}</div><hr>${msg.body_html}`
    : undefined;

  return sendMail(accountId, { to, subject, text, html });
}

/**
 * Проверить SMTP-настройки аккаунта (через transporter.verify()).
 * Возвращает { ok: true } или { ok: false, error }.
 * @param {object} account — объект с расшифрованным или зашифрованным smtp_pass_enc
 */
export async function testSmtp(account) {
  let transporter;
  try {
    transporter = buildTransport(account);
    await withTimeout(transporter.verify(), TEST_TIMEOUT_MS, 'smtp verify');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (transporter) {
      try {
        transporter.close();
      } catch (_) {
        /* ignore */
      }
    }
  }
}
