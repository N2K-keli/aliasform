import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server.js';

export const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake webm payload')]);
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A fake mp4 payload')]);

export function tempDir(prefix = 'aila-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Builds an app on a fresh temporary DATA_DIR. */
export async function makeApp(env = {}, opts = {}) {
  const dataDir = tempDir();
  const config = loadConfig({
    NODE_ENV: 'test',
    ADMIN_PASSWORD: 'secret',
    DATA_DIR: dataDir,
    RATE_LIMIT_API_PER_MIN: '100000',
    RATE_LIMIT_UPLOADS_PER_HOUR: '100000',
    ...env,
  });
  const app = await buildApp(config, { logger: false, ...opts });
  const cleanup = async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { app, config, dataDir, cleanup };
}

/** Builds a multipart/form-data body. Fields: { name: string | { data, type, filename } }. */
export function multipart(fields) {
  const boundary = '----aila' + crypto.randomBytes(8).toString('hex');
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`));
      chunks.push(Buffer.from(value, 'utf8'));
    } else {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename || 'blob'}"\r\n` +
        `Content-Type: ${value.type}\r\n\r\n`));
      chunks.push(value.data);
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function startSession(app, email = 'user@example.com', language = 'basaa', base = '/collect') {
  const res = await app.inject({ method: 'POST', url: `${base}/api/session`, payload: { email, language } });
  return res.json();
}

export async function putResponse(app, token, wordId, fields, base = '/collect') {
  const { payload, headers } = multipart(fields);
  return app.inject({
    method: 'PUT',
    url: `${base}/api/responses/${wordId}`,
    payload,
    headers: { ...headers, 'x-contributor-token': token },
  });
}

export function adminAuth(user = 'admin', pass = 'secret') {
  return { authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
}
