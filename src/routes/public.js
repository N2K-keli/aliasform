import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PUBLIC_DIR } from '../config.js';
import { LANGUAGES, isLanguage } from '../languages.js';
import { nowIso } from '../db.js';
import {
  validateAudio, audioRelPath, writeAudioFile, deleteAudioFile, mimeForPath, sendAudio, httpError,
} from '../audio.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Fills __BASE_PATH__ and __CONFIG__ placeholders. The JSON is safe to embed in a <script>. */
export function renderTemplate(file, basePath, clientConfig) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const json = JSON.stringify(clientConfig).replace(/</g, '\\u003c');
  return html.replaceAll('__BASE_PATH__', basePath).replace('__CONFIG__', () => json);
}

export function normalizeText(value) {
  return String(value ?? '').normalize('NFC').trim();
}

export default async function publicRoutes(app) {
  const { config, stmts, db } = app;

  const page = renderTemplate('collect.html', config.publicPath, {
    basePath: config.publicPath,
    maxAudioSeconds: config.maxAudioSeconds,
    maxTextChars: config.maxTextChars,
    languages: LANGUAGES,
  });

  const apiLimit = { rateLimit: { max: config.rateLimitApiPerMin, timeWindow: '1 minute' } };
  const uploadLimit = { rateLimit: { max: config.rateLimitUploadsPerHour, timeWindow: '1 hour' } };

  app.get('/', (request, reply) => {
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(page);
  });

  app.get('/assets/app.css', (request, reply) => reply.sendFile('assets/app.css'));
  app.get('/assets/collect.js', (request, reply) => reply.sendFile('collect.js'));

  async function requireContributor(request) {
    const token = request.headers['x-contributor-token'];
    const contributor = typeof token === 'string' && TOKEN_RE.test(token)
      ? stmts.getContributorByToken.get(token)
      : undefined;
    if (!contributor) {
      throw httpError(401, 'invalid_token', 'Session invalide. Veuillez saisir à nouveau votre e-mail.');
    }
    request.contributor = contributor;
  }

  function progress(contributorId) {
    return {
      done_count: stmts.doneCount.get(contributorId).n,
      first_pending_word_id: stmts.firstPending.get(contributorId)?.id ?? null,
    };
  }

  app.post('/api/session', { config: apiLimit }, async (request) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const language = body.language;
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      throw httpError(400, 'invalid_email', 'Adresse e-mail invalide.');
    }
    if (!isLanguage(language)) throw httpError(400, 'invalid_language', 'Langue inconnue.');

    const now = nowIso();
    const contributor = db.transaction(() => {
      const existing = stmts.getContributorByPair.get(email, language);
      if (existing) {
        stmts.touchContributor.run(now, existing.id);
        return existing;
      }
      const token = crypto.randomBytes(32).toString('hex');
      const info = stmts.insertContributor.run(email, language, token, now, now);
      return { id: info.lastInsertRowid, email, language, token };
    })();

    return {
      token: contributor.token,
      email,
      language,
      total_words: stmts.allWords.all().length,
      ...progress(contributor.id),
    };
  });

  app.get('/api/words', { config: apiLimit, onRequest: requireContributor }, async (request) => {
    const words = stmts.allWords.all();
    const state = new Map(stmts.contributorResponses.all(request.contributor.id).map((r) => [r.word_id, r]));

    const categories = [];
    for (const w of words) {
      const last = categories[categories.length - 1];
      if (last && last.name === w.category) last.count++;
      else categories.push({ name: w.category, order: w.category_order, count: 1, first_word_id: w.id });
    }

    return {
      categories,
      words: words.map((w) => {
        const r = state.get(w.id);
        return {
          id: w.id,
          category: w.category,
          french_text: w.french_text,
          has_audio: Boolean(r?.audio_path),
          has_text: r?.text != null,
          text: r?.text ?? null,
        };
      }),
    };
  });

  app.put('/api/responses/:wordId', { config: uploadLimit, onRequest: requireContributor }, async (request) => {
    const contributor = request.contributor;
    const word = stmts.getWord.get(String(request.params.wordId));
    if (!word) throw httpError(404, 'unknown_word', 'Mot inconnu.');
    if (!request.isMultipart()) throw httpError(400, 'bad_request', 'Requête invalide.');

    // Read all parts first; validate everything before touching the disk.
    let audioBuffer = null;
    let audioMime = null;
    let text;
    let removeAudio = false;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        if (part.fieldname === 'audio' && audioBuffer === null) {
          audioBuffer = buf;
          audioMime = part.mimetype;
        }
      } else if (part.fieldname === 'text') {
        text = normalizeText(part.value);
      } else if (part.fieldname === 'remove_audio') {
        removeAudio = String(part.value) === '1';
      }
    }

    if (text !== undefined && text.length > config.maxTextChars) {
      throw httpError(400, 'text_too_long', `La traduction dépasse ${config.maxTextChars} caractères.`);
    }
    const audio = audioBuffer !== null
      ? validateAudio(audioBuffer, audioMime, config.maxAudioMb * 1024 * 1024)
      : null;

    const existing = stmts.getResponse.get(contributor.id, word.id);
    let audioPath = existing?.audio_path ?? null;
    let audioMimeOut = existing?.audio_mime ?? null;
    let audioBytes = existing?.audio_bytes ?? null;
    let newPath = null;

    if (audio) {
      newPath = audioRelPath(contributor.language, word.id, contributor.id, audio.ext);
      writeAudioFile(config.audioDir, newPath, audioBuffer);
      audioPath = newPath;
      audioMimeOut = audio.mime;
      audioBytes = audioBuffer.length;
    } else if (removeAudio) {
      audioPath = audioMimeOut = audioBytes = null;
    }

    const finalText = text !== undefined ? (text === '' ? null : text) : (existing?.text ?? null);
    const now = nowIso();

    try {
      if (audioPath === null && finalText === null) {
        if (existing) stmts.deleteResponse.run(contributor.id, word.id);
      } else {
        stmts.upsertResponse.run({
          contributor_id: contributor.id,
          word_id: word.id,
          audio_path: audioPath,
          audio_mime: audioMimeOut,
          audio_bytes: audioBytes,
          text: finalText,
          now,
        });
      }
    } catch (err) {
      if (newPath && newPath !== existing?.audio_path) deleteAudioFile(config.audioDir, newPath);
      throw err;
    }

    // The previous file is obsolete if it was replaced by a different path or removed.
    if (existing?.audio_path && existing.audio_path !== audioPath) {
      deleteAudioFile(config.audioDir, existing.audio_path);
    }

    return {
      word_id: word.id,
      has_audio: audioPath !== null,
      has_text: finalText !== null,
      text: finalText,
      updated_at: now,
    };
  });

  app.get('/api/responses/:wordId/audio', { config: apiLimit, onRequest: requireContributor }, async (request, reply) => {
    const r = stmts.getResponse.get(request.contributor.id, String(request.params.wordId));
    if (!r?.audio_path) throw httpError(404, 'not_found', 'Aucun enregistrement.');
    reply.header('Cache-Control', 'private, no-store');
    return sendAudio(request, reply, path.join(config.audioDir, r.audio_path), mimeForPath(r.audio_path, r.audio_mime));
  });
}
