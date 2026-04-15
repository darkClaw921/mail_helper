// Общий pino-логгер для бэкенда.
//
// Сериализаторы:
//   * err — стандартный pino.stdSerializers.err; раскрывает stack / code / причина,
//     поэтому логи содержат полный stack, а клиент его никогда не видит (см. index.js).
//   * req/res — стандартные сериализаторы pino-http для HTTP-запросов.

import { pino } from 'pino';

import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'mail-helper' },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});
