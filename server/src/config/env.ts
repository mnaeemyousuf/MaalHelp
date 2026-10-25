import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader (no dependency): KEY=VALUE lines, existing env wins. */
function loadDotEnv(): void {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
if (process.env.NODE_ENV !== 'test') loadDotEnv();

const bool = (def: boolean) =>
  z.preprocess((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())), z.boolean());
const num = (def: number) => z.preprocess((v) => (v === undefined || v === '' ? def : Number(v)), z.number());
const str = (def: string) => z.preprocess((v) => (v === undefined || v === '' ? def : v), z.string());
const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: num(4000),
  HOST: str('0.0.0.0'),
  APP_ORIGIN: str('http://localhost:5173'),
  DATABASE_URL: optional,
  PGLITE_DIR: str('./.data/pg'),
  DB_POOL_MAX: num(10),
  SESSION_SECRET: str('dev-only-session-secret-change-me-please'),
  ENCRYPTION_KEY: optional,
  SESSION_TTL_HOURS: num(12),
  COOKIE_SECURE: bool(false),
  MISTRAL_API_KEY: optional,
  MISTRAL_API_URL: str('https://api.mistral.ai/v1'),
  MISTRAL_CHAT_MODEL: str('mistral-small-latest'),
  MISTRAL_OCR_MODEL: str('mistral-ocr-latest'),
  MISTRAL_TIMEOUT_MS: num(20000),
  MISTRAL_MAX_RETRIES: num(2),
  AI_RATE_LIMIT_PER_MINUTE: num(20),
  AI_COST_INPUT_PER_MTOK: num(0.1),
  AI_COST_OUTPUT_PER_MTOK: num(0.3),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: str('./.data/uploads'),
  S3_ENDPOINT: optional,
  S3_REGION: str('auto'),
  S3_BUCKET: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  MAX_UPLOAD_MB: num(15),
  JOBS_ENABLED: bool(true),
  JOBS_POLL_MS: num(5000),
  DAILY_BRIEFING_HOUR: num(7),
  EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
  SMTP_URL: optional,
  EMAIL_FROM: str('Maal Help <no-reply@maalhelp.local>'),
  WHATSAPP_PROVIDER: z.enum(['log', 'cloud_api']).default('log'),
  WHATSAPP_API_URL: optional,
  WHATSAPP_API_TOKEN: optional,
  LOG_LEVEL: str('info'),
  SEED_DEMO: bool(true),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

if (isProd) {
  const problems: string[] = [];
  if (!env.DATABASE_URL) problems.push('DATABASE_URL is required in production (managed PostgreSQL).');
  if (/dev-only|change-me/i.test(env.SESSION_SECRET) || env.SESSION_SECRET.length < 32) problems.push('SESSION_SECRET must be a random value of at least 32 characters.');
  if (!env.ENCRYPTION_KEY) problems.push('ENCRYPTION_KEY is required in production.');
  if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production (HTTPS).');
  if (problems.length) {
    console.error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
}
