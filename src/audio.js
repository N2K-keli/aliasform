import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Allowed MIME types (codec parameters stripped) and the file extension used on disk.
export const AUDIO_TYPES = {
  'audio/webm': { ext: 'webm', kind: 'webm' },
  'audio/mp4': { ext: 'm4a', kind: 'mp4' },
  'audio/x-m4a': { ext: 'm4a', kind: 'mp4' },
  'audio/aac': { ext: 'aac', kind: 'mp4' },
  'audio/ogg': { ext: 'ogg', kind: 'ogg' },
  'audio/mpeg': { ext: 'mp3', kind: 'mp3' },
  'audio/wav': { ext: 'wav', kind: 'wav' },
};

const EXT_MIME = { webm: 'audio/webm', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav' };

export function baseMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function magicMatches(kind, b) {
  switch (kind) {
    case 'webm':
      return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case 'mp4':
      // MP4/M4A: 'ftyp' at offset 4. Raw AAC (ADTS) starts with the 0xFFF sync word.
      return (b.length >= 8 && b.toString('latin1', 4, 8) === 'ftyp') ||
        (b.length >= 2 && b[0] === 0xff && (b[1] & 0xf0) === 0xf0);
    case 'ogg':
      return b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS';
    case 'wav':
      return b.length >= 4 && b.toString('latin1', 0, 4) === 'RIFF';
    case 'mp3':
      return (b.length >= 3 && b.toString('latin1', 0, 3) === 'ID3') ||
        (b.length >= 2 && b[0] === 0xff && [0xfb, 0xf3, 0xf2].includes(b[1]));
    default:
      return false;
  }
}

export function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code, expose: true });
}

/**
 * Validates an uploaded audio buffer. Returns { mime, ext } or throws an
 * error carrying statusCode/code for the HTTP layer.
 */
export function validateAudio(buffer, mimeType, maxBytes) {
  if (!buffer || buffer.length === 0) throw httpError(400, 'empty_audio', 'Le fichier audio est vide.');
  if (buffer.length > maxBytes) throw httpError(413, 'audio_too_large', 'Le fichier audio est trop volumineux.');
  const mime = baseMime(mimeType);
  const type = AUDIO_TYPES[mime];
  if (!type) throw httpError(415, 'unsupported_audio', 'Format audio non pris en charge.');
  if (!magicMatches(type.kind, buffer)) {
    throw httpError(415, 'unsupported_audio', 'Le contenu du fichier ne correspond pas au format audio annoncé.');
  }
  return { mime, ext: type.ext };
}

/** Path (relative to the audio dir) of a response's audio file. */
export function audioRelPath(language, wordId, contributorId, ext) {
  return `${language}/${wordId}__c${contributorId}.${ext}`;
}

/** Writes atomically: temp file in the same folder, then rename into place. */
export function writeAudioFile(audioDir, relPath, buffer) {
  const full = path.join(audioDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, full);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function deleteAudioFile(audioDir, relPath) {
  if (!relPath) return;
  try {
    fs.unlinkSync(path.join(audioDir, relPath));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export function mimeForPath(relPath, storedMime) {
  if (storedMime) return storedMime;
  return EXT_MIME[path.extname(relPath).slice(1)] || 'application/octet-stream';
}

/** Streams an audio file with HTTP Range support. */
export function sendAudio(request, reply, fullPath, mime) {
  let size;
  try {
    size = fs.statSync(fullPath).size;
  } catch {
    return reply.code(404).send({ error: 'not_found', message: 'Aucun enregistrement.' });
  }
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', mime);

  const range = request.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start, end;
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
    }
    if (start === undefined || start > end || start >= size) {
      reply.header('Content-Range', `bytes */${size}`);
      return reply.code(416).send();
    }
    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Length', end - start + 1);
    return reply.send(fs.createReadStream(fullPath, { start, end }));
  }
  reply.header('Content-Length', size);
  return reply.send(fs.createReadStream(fullPath));
}
