import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import fastifyBasicAuth from '@fastify/basic-auth';
import { ZipArchive } from 'archiver';
import { LANGUAGES, isLanguage } from '../languages.js';
import { mimeForPath, sendAudio, httpError } from '../audio.js';
import { renderTemplate } from './public.js';

const FAILED_LOGIN_MAX = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

const CSV_COLUMNS = [
  'response_id', 'word_id', 'category', 'french_text', 'language', 'email', 'text',
  'audio_file', 'audio_mime', 'created_at', 'updated_at',
];

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

/** One CSV cell: CSV-injection guard, then RFC 4180 quoting. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const csvLine = (values) => values.map(csvCell).join(',') + '\r\n';

function manifestRow(r) {
  return {
    ...r,
    audio_file: r.audio_path ? `audio/${r.audio_path}` : '',
    audio_mime: r.audio_path ? r.audio_mime : '',
  };
}

function yyyymmdd(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Builds the WHERE clause shared by the list and the exports. */
function buildFilters(query, { withSearch = true } = {}) {
  const where = [];
  const params = {};
  if (query.language) {
    if (!isLanguage(query.language)) throw httpError(400, 'invalid_language', 'Langue inconnue.');
    where.push('c.language = @language');
    params.language = query.language;
  }
  if (withSearch) {
    if (query.category) {
      where.push('w.category = @category');
      params.category = String(query.category);
    }
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q) {
      where.push("fold(w.french_text) LIKE '%' || @q || '%' ESCAPE '\\'");
      params.q = q.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m);
    }
    if (query.has_audio === '1') where.push('r.audio_path IS NOT NULL');
    if (query.has_text === '1') where.push('r.text IS NOT NULL');
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const BASE_SELECT = `
  SELECT r.id AS response_id, r.word_id, w.category, w.french_text, c.language, c.email, r.text,
         r.audio_path, r.audio_mime, r.created_at, r.updated_at
  FROM responses r
  JOIN contributors c ON c.id = r.contributor_id
  JOIN words w ON w.id = r.word_id`;

export default async function adminRoutes(app) {
  const { config, db, stmts } = app;

  // Failed-login counter per IP (in memory; resets on restart).
  const failures = new Map();
  const isLocked = (ip) => {
    const f = failures.get(ip);
    if (!f) return false;
    if (Date.now() > f.resetAt) { failures.delete(ip); return false; }
    return f.count >= FAILED_LOGIN_MAX;
  };
  const recordFailure = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() > f.resetAt) failures.set(ip, { count: 1, resetAt: Date.now() + FAILED_LOGIN_WINDOW_MS });
    else f.count++;
  };

  await app.register(fastifyBasicAuth, {
    authenticate: { realm: 'Admin' },
    validate: async (username, password, request) => {
      if (isLocked(request.ip)) {
        throw httpError(429, 'too_many_attempts', 'Trop de tentatives. Réessayez dans 15 minutes.');
      }
      // Evaluate both comparisons to keep the timing independent of which one fails.
      const okUser = safeEqual(username, config.adminUser);
      const okPass = safeEqual(password, config.adminPassword);
      if (!(okUser && okPass)) {
        recordFailure(request.ip);
        throw httpError(401, 'unauthorized', 'Identifiants incorrects.');
      }
    },
  });

  app.addHook('onRequest', app.basicAuth);
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  const page = renderTemplate('admin.html', config.adminPath, {
    basePath: config.adminPath,
    languages: LANGUAGES,
  });

  app.get('/', (request, reply) => reply.type('text/html; charset=utf-8').send(page));
  app.get('/assets/app.css', (request, reply) => reply.sendFile('assets/app.css'));
  app.get('/assets/admin.js', (request, reply) => reply.sendFile('admin.js'));

  const statsStmt = db.prepare(`
    SELECT c.language,
           COUNT(r.id) AS responses,
           SUM(r.audio_path IS NOT NULL) AS with_audio,
           SUM(r.text IS NOT NULL) AS with_text,
           COUNT(DISTINCT CASE WHEN r.audio_path IS NOT NULL THEN r.word_id END) AS words_covered
    FROM responses r JOIN contributors c ON c.id = r.contributor_id
    GROUP BY c.language`);
  const contributorsStmt = db.prepare('SELECT language, COUNT(*) AS n FROM contributors GROUP BY language');
  const categoriesStmt = db.prepare(
    'SELECT category, MIN(category_order) AS o FROM words GROUP BY category ORDER BY o');

  app.get('/api/stats', async () => {
    const totalWords = stmts.allWords.all().length;
    const byLang = new Map(statsStmt.all().map((s) => [s.language, s]));
    const contributors = new Map(contributorsStmt.all().map((c) => [c.language, c.n]));
    return {
      total_words: totalWords,
      categories: categoriesStmt.all().map((c) => c.category),
      languages: LANGUAGES.map(({ code, label }) => {
        const s = byLang.get(code);
        return {
          language: code,
          label,
          contributors: contributors.get(code) ?? 0,
          responses: s?.responses ?? 0,
          with_audio: s?.with_audio ?? 0,
          with_text: s?.with_text ?? 0,
          words_covered: s?.words_covered ?? 0,
          total_words: totalWords,
        };
      }),
    };
  });

  app.get('/api/responses', async (request) => {
    const q = request.query;
    const { sql, params } = buildFilters(q);
    const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, Number.parseInt(q.page_size, 10) || 50));
    const total = db.prepare(`SELECT COUNT(*) AS n FROM (${BASE_SELECT} ${sql})`).get(params).n;
    const rows = db.prepare(`${BASE_SELECT} ${sql} ORDER BY r.updated_at DESC, r.id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
    return {
      total,
      page,
      page_size: pageSize,
      rows: rows.map((r) => ({
        response_id: r.response_id,
        word_id: r.word_id,
        category: r.category,
        french_text: r.french_text,
        language: r.language,
        email: r.email,
        text: r.text,
        has_audio: r.audio_path !== null,
        audio_mime: r.audio_mime,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    };
  });

  app.get('/api/audio/:responseId', async (request, reply) => {
    const id = Number.parseInt(request.params.responseId, 10);
    const r = Number.isInteger(id) ? stmts.getResponseById.get(id) : undefined;
    if (!r?.audio_path) throw httpError(404, 'not_found', 'Aucun enregistrement.');
    return sendAudio(request, reply, path.join(config.audioDir, r.audio_path), mimeForPath(r.audio_path, r.audio_mime));
  });

  app.get('/api/export.csv', async (request, reply) => {
    const { sql, params } = buildFilters(request.query);
    let out = '﻿' + csvLine(CSV_COLUMNS);
    for (const r of db.prepare(`${BASE_SELECT} ${sql} ORDER BY r.updated_at DESC, r.id DESC`).iterate(params)) {
      const row = manifestRow(r);
      out += csvLine(CSV_COLUMNS.map((c) => row[c]));
    }
    reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="aila-export-${request.query.language || 'all'}-${yyyymmdd()}.csv"`);
    return out;
  });

  app.get('/api/export.zip', async (request, reply) => {
    const { sql, params } = buildFilters({ language: request.query.language }, { withSearch: false });
    const rows = db.prepare(`${BASE_SELECT} ${sql} ORDER BY r.updated_at DESC, r.id DESC`).all(params);

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('warning', (err) => request.log.warn(err, 'zip warning'));
    archive.on('error', (err) => request.log.error(err, 'zip error'));

    let manifest = '﻿' + csvLine(CSV_COLUMNS);
    const files = [];
    for (const r of rows) {
      const full = r.audio_path ? path.join(config.audioDir, r.audio_path) : null;
      const exists = full !== null && fs.existsSync(full);
      const row = manifestRow(exists ? r : { ...r, audio_path: null });
      manifest += csvLine(CSV_COLUMNS.map((c) => row[c]));
      if (exists) files.push({ full, name: row.audio_file });
    }

    const filename = `aila-export-${request.query.language || 'all'}-${yyyymmdd()}.zip`;
    reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${filename}"`);

    archive.append(manifest, { name: 'manifest.csv' });
    // Audio is already compressed: store it as-is.
    for (const f of files) archive.file(f.full, { name: f.name, store: true });
    archive.finalize();
    return reply.send(archive);
  });
}
