// AES-256-GCM шифрование для секретов в БД.
// Формат: base64(iv):base64(tag):base64(ciphertext)
// MASTER_KEY — 32-байтовый ключ, хранится в .env как 64 hex символа.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { config } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;   // рекомендованный размер IV для GCM
const TAG_LEN = 16;
const KEY_LEN = 32;

function getKey() {
  const hex = config.MASTER_KEY;
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('MASTER_KEY is invalid — expected 64 hex characters (32 bytes)');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_LEN) {
    throw new Error(`MASTER_KEY must decode to ${KEY_LEN} bytes`);
  }
  return key;
}

/**
 * Зашифровать строку в base64(iv):base64(tag):base64(ciphertext).
 * @param {string} plaintext
 * @returns {string}
 */
export function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() expects a string');
  }
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Расшифровать строку, созданную encrypt().
 * @param {string} packed
 * @returns {string}
 */
export function decrypt(packed) {
  if (typeof packed !== 'string') {
    throw new TypeError('decrypt() expects a string');
  }
  const parts = packed.split(':');
  if (parts.length !== 3) {
    throw new Error('decrypt(): malformed ciphertext (expected iv:tag:ciphertext)');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LEN) throw new Error('decrypt(): bad IV length');
  if (tag.length !== TAG_LEN) throw new Error('decrypt(): bad auth tag length');

  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
