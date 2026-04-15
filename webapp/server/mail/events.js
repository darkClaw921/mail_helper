// Глобальная шина событий почтового пайплайна.
// Позволяет подписчикам (Ф4 classifier, Ф6 WS hub, Ф5 actions) слушать события
// без жёсткой зависимости от accountManager/imapWorker.
//
// Список событий:
//   'message:new'        — сырое событие от imapWorker (account_id, uid). Внутренее,
//                          обычно не нужно подписчикам вне этой папки.
//   'message:stored'     — письмо распарсено и сохранено в БД. payload: { message }
//                          (та же структура что возвращает fetcher.fetchAndStore).
//   'message:classified' — письмо прошло LLM-классификацию, classification_json
//                          уже записан в БД. payload: { message, classification, prompt }.
//                          Подписываются: Ф5 actions/runner, Ф6 WS hub.
//   'message:updated'    — флаги письма (is_read / is_important) изменились.
//                          payload: { id, account_id?, is_read?, is_important?, source? }.
//                          Эмитится из services/messages.markFlags (PATCH/WS mark_read)
//                          и из imapWorker при получении IMAP flags event (source:'imap').
//                          Подписчик — WS hub, делает broadcast('updated', {...}). См. Ф8.
//
// Использование:
//   import { mailEvents } from './mail/events.js';
//   mailEvents.on('message:stored', ({ message }) => { ... });

import { EventEmitter } from 'node:events';

export const mailEvents = new EventEmitter();
// Разрешаем много слушателей — все последующие фазы подпишутся сюда.
mailEvents.setMaxListeners(50);
