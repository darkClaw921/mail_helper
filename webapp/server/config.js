// Загрузка .env + валидация обязательных переменных окружения через zod.
// При невалидных данных печатает понятное сообщение и выходит с кодом 1.

import 'dotenv/config';
import { z } from 'zod';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  MASTER_KEY: z
    .string({ required_error: 'MASTER_KEY is required (64 hex chars)' })
    .regex(/^[0-9a-fA-F]{64}$/, 'MASTER_KEY is required (64 hex chars)'),
  DB_PATH: z.string().min(1).default('./data.db'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.errors
    .map((e) => `  - ${e.path.join('.') || '(root)'}: ${e.message}`)
    .join('\n');
  console.error('Invalid environment configuration:\n' + issues);
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
