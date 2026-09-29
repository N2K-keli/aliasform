import path from 'node:path';
import { fileURLToPath } from 'node:url';

function normalizePath(value, fallback) {
  let p = (value ?? '').trim() || fallback;
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '');
  if (p === '') throw new Error('PUBLIC_PATH / ADMIN_PATH cannot be the root "/"');
  if (!/^(\/[A-Za-z0-9_-]+)+$/.test(p)) throw new Error(`Invalid path "${p}" (allowed: letters, digits, "_", "-", "/")`);
  return p;
}

function int(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid value for ${name}: ${value}`);
  return n;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Reads and validates configuration from an env object. Throws on invalid config. */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'production';
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  if (!adminPassword) throw new Error('ADMIN_PASSWORD is required');
  if (nodeEnv === 'production' && adminPassword === 'change-me') {
    throw new Error('ADMIN_PASSWORD must be changed from "change-me" in production');
  }

  const publicPath = normalizePath(env.PUBLIC_PATH, '/collect');
  const adminPath = normalizePath(env.ADMIN_PATH, '/adminView');
  if (publicPath === adminPath) throw new Error('PUBLIC_PATH and ADMIN_PATH must differ');

  const dataDir = path.resolve(env.DATA_DIR || './data');

  return {
    nodeEnv,
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 3000, 'PORT'),
    publicPath,
    adminPath,
    adminUser: env.ADMIN_USER || 'admin',
    adminPassword,
    dataDir,
    dbFile: path.join(dataDir, 'app.db'),
    audioDir: path.join(dataDir, 'audio'),
    backupDir: path.join(dataDir, 'backups'),
    maxAudioSeconds: int(env.MAX_AUDIO_SECONDS, 60, 'MAX_AUDIO_SECONDS'),
    maxAudioMb: int(env.MAX_AUDIO_MB, 10, 'MAX_AUDIO_MB'),
    maxTextChars: int(env.MAX_TEXT_CHARS, 500, 'MAX_TEXT_CHARS'),
    trustProxy: bool(env.TRUST_PROXY, true),
    rateLimitApiPerMin: int(env.RATE_LIMIT_API_PER_MIN, 300, 'RATE_LIMIT_API_PER_MIN'),
    rateLimitUploadsPerHour: int(env.RATE_LIMIT_UPLOADS_PER_HOUR, 600, 'RATE_LIMIT_UPLOADS_PER_HOUR'),
    logLevel: env.LOG_LEVEL || 'info',
  };
}

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
