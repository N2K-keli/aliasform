import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { loadConfig, PUBLIC_DIR } from './config.js';
import { openDb, prepareStatements } from './db.js';
import { seedWords, printSummary, DEFAULT_CSV } from '../scripts/seed.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';


const ERROR_MESSAGES = {
  400: 'Requête invalide.',
  401: 'Authentification requise.',
  404: 'Introuvable.',
  406: 'Requête invalide.',
  413: 'Le fichier audio est trop volumineux.',
  415: 'Format non pris en charge.',
  429: 'Trop de requêtes. Réessayez dans un instant.',
  500: 'Erreur interne du serveur.',
};

const ERROR_CODES = { 400: 'bad_request', 401: 'unauthorized', 404: 'not_found', 406: 'bad_request', 413: 'too_large', 415: 'unsupported_media_type', 429: 'rate_limited' };

/** Builds the Fastify app. Opens the DB and seeds the words if the table is empty. */
export async function buildApp(config, { csvPath = DEFAULT_CSV, logger } = {}) {
  const app = Fastify({
    trustProxy: config.trustProxy,
    routerOptions: { ignoreTrailingSlash: true },
    logger: logger ?? {
      level: config.logLevel,
      redact: ['req.body', 'req.headers.authorization', 'req.headers["x-contributor-token"]', 'req.headers.cookie'],
    },
  });

  fs.mkdirSync(config.audioDir, { recursive: true });
  const db = openDb(config.dbFile);
  // Accent- and case-insensitive folding for admin search.
  db.function('fold', { deterministic: true }, (s) =>
    s == null ? null : String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());

  if (db.prepare('SELECT COUNT(*) AS n FROM words').get().n === 0) {
    const summary = seedWords(db, csvPath);
    printSummary(summary, (msg) => app.log.info(msg));
  }

  const stmts = prepareStatements(db);
  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('stmts', stmts);
  app.addHook('onClose', async () => { if (db.open) db.close(); });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'microphone=(self)');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  app.setErrorHandler((err, request, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) request.log.error(err);
    else request.log.info({ code: err.code, status }, 'request rejected');
    const code = err.expose && err.code ? err.code : (ERROR_CODES[status] || 'error');
    const message = err.expose && err.message ? err.message : (ERROR_MESSAGES[status] || ERROR_MESSAGES[500]);
    reply.code(status).send({ error: code, message });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'Page introuvable.' });
  });

  await app.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: () => ({
      statusCode: 429, code: 'rate_limited', expose: true,
      message: 'Trop de requêtes. Réessayez dans un instant.',
    }),
  });
  await app.register(fastifyStatic, { root: PUBLIC_DIR, serve: false });
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.maxAudioMb * 1024 * 1024,
      files: 1,
      fields: 5,
      fieldSize: 64 * 1024,
      parts: 6,
    },
  });

  app.get('/healthz', async () => {
    stmts.ping.get();
    return { ok: true };
  });
  app.get('/', (request, reply) => reply.redirect(config.publicPath, 302));

  await app.register(publicRoutes, { prefix: config.publicPath });
  await app.register(adminRoutes, { prefix: config.adminPath });

  return app;
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  const app = await buildApp(config);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close(); // also closes the SQLite handle (onClose hook)
      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
