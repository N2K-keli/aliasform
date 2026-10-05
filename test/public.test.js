import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp, startSession, putResponse, WEBM, MP4 } from './helpers.js';

describe('session', () => {
  let ctx;
  before(async () => { ctx = await makeApp(); });
  after(async () => { await ctx.cleanup(); });

  test('same email + language returns the same token; email is lowercased', async () => {
    const a = await startSession(ctx.app, '  Alice@Example.COM ', 'ewondo');
    const b = await startSession(ctx.app, 'alice@example.com', 'ewondo');
    assert.equal(a.email, 'alice@example.com');
    assert.match(a.token, /^[0-9a-f]{64}$/);
    assert.equal(a.token, b.token);
    assert.equal(a.total_words, 363);
    assert.equal(a.done_count, 0);
    assert.equal(a.first_pending_word_id, 'ASD-0262');
  });

  test('a different language creates a separate contributor', async () => {
    const a = await startSession(ctx.app, 'bob@example.com', 'ewondo');
    const b = await startSession(ctx.app, 'bob@example.com', 'ghomala');
    assert.notEqual(a.token, b.token);
    const n = ctx.app.db.prepare("SELECT COUNT(*) AS n FROM contributors WHERE email = 'bob@example.com'").get().n;
    assert.equal(n, 2);
  });

  test('words: navigation order, no empty categories, duplicates kept', async () => {
    const { token } = await startSession(ctx.app, 'carol@example.com', 'basaa');
    const res = await ctx.app.inject({ url: '/collect/api/words', headers: { 'x-contributor-token': token } });
    assert.equal(res.statusCode, 200);
    const { categories, words } = res.json();
    assert.equal(words.length, 363);
    assert.deepEqual(categories.map((c) => c.name), [
      'Salutations', 'Prendre des nouvelles', 'Couleurs', 'Nombres', 'Famille', 'Corps',
      'Nourriture et boissons', 'Maison', 'Animaux', 'École',
    ]);
    assert.equal(categories[0].count, 93);
    assert.equal(categories[0].first_word_id, 'ASD-0262');
    assert.equal(words[0].french_text, "S'il te plaît");
    assert.equal(words.filter((w) => w.french_text === 'Riz').length, 2);
  });

  test('missing or invalid token → 401', async () => {
    const a = await ctx.app.inject({ url: '/collect/api/words' });
    assert.equal(a.statusCode, 401);
    const b = await ctx.app.inject({ url: '/collect/api/words', headers: { 'x-contributor-token': 'f'.repeat(64) } });
    assert.equal(b.statusCode, 401);
    assert.ok(b.json().message);
  });
});

describe('PUT /responses/:wordId', () => {
  let ctx, token, contributorId;
  const audioFile = (rel) => path.join(ctx.config.audioDir, rel);
  const row = (wordId) => ctx.app.db
    .prepare('SELECT * FROM responses WHERE contributor_id = ? AND word_id = ?').get(contributorId, wordId);

  before(async () => {
    ctx = await makeApp();
    ({ token } = await startSession(ctx.app, 'dan@example.com', 'basaa'));
    contributorId = ctx.app.db.prepare('SELECT id FROM contributors WHERE token = ?').get(token).id;
  });
  after(async () => { await ctx.cleanup(); });

  test('audio only', async () => {
    const res = await putResponse(ctx.app, token, 'ASD-0262', { audio: { data: WEBM, type: 'audio/webm;codecs=opus' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual({ ...res.json(), updated_at: undefined },
      { word_id: 'ASD-0262', has_audio: true, has_text: false, text: null, updated_at: undefined });
    const r = row('ASD-0262');
    assert.equal(r.audio_path, `basaa/ASD-0262__c${contributorId}.webm`);
    assert.equal(r.audio_mime, 'audio/webm');
    assert.deepEqual(fs.readFileSync(audioFile(r.audio_path)), WEBM);

    const audio = await ctx.app.inject({ url: '/collect/api/responses/ASD-0262/audio', headers: { 'x-contributor-token': token } });
    assert.equal(audio.statusCode, 200);
    assert.equal(audio.headers['content-type'], 'audio/webm');
    assert.equal(audio.headers['accept-ranges'], 'bytes');
    const partial = await ctx.app.inject({
      url: '/collect/api/responses/ASD-0262/audio',
      headers: { 'x-contributor-token': token, range: 'bytes=0-3' },
    });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.headers['content-range'], `bytes 0-3/${WEBM.length}`);
    assert.equal(partial.rawPayload.length, 4);
  });

  test('text only, then both, then clearing text', async () => {
    let res = await putResponse(ctx.app, token, 'ASD-0263', { text: '  bonjour  ' });
    assert.equal(res.json().text, 'bonjour');
    assert.equal(res.json().has_audio, false);

    res = await putResponse(ctx.app, token, 'ASD-0263', { audio: { data: MP4, type: 'audio/mp4' } });
    assert.equal(res.json().has_audio, true);
    assert.equal(res.json().text, 'bonjour', 'text kept when not sent');
    assert.ok(row('ASD-0263').audio_path.endsWith('.m4a'));

    res = await putResponse(ctx.app, token, 'ASD-0263', { text: '' });
    assert.equal(res.json().has_text, false);
    assert.equal(row('ASD-0263').text, null);
    assert.equal(row('ASD-0263').audio_path !== null, true);
  });

  test('remove_audio and row deletion when both are empty', async () => {
    await putResponse(ctx.app, token, 'ASD-0264', { audio: { data: WEBM, type: 'audio/webm' }, text: 'x' });
    const rel = row('ASD-0264').audio_path;
    let res = await putResponse(ctx.app, token, 'ASD-0264', { remove_audio: '1' });
    assert.equal(res.json().has_audio, false);
    assert.equal(fs.existsSync(audioFile(rel)), false);
    assert.equal(row('ASD-0264').text, 'x');

    res = await putResponse(ctx.app, token, 'ASD-0264', { text: '' });
    assert.equal(res.statusCode, 200);
    assert.equal(row('ASD-0264'), undefined);
  });

  test('re-recording replaces the file (old one removed)', async () => {
    await putResponse(ctx.app, token, 'ASD-0265', { audio: { data: WEBM, type: 'audio/webm' } });
    const oldRel = row('ASD-0265').audio_path;
    await putResponse(ctx.app, token, 'ASD-0265', { audio: { data: MP4, type: 'audio/mp4' } });
    const newRel = row('ASD-0265').audio_path;
    assert.notEqual(oldRel, newRel);
    assert.equal(fs.existsSync(audioFile(oldRel)), false);
    assert.deepEqual(fs.readFileSync(audioFile(newRel)), MP4);
    const n = ctx.app.db.prepare("SELECT COUNT(*) AS n FROM responses WHERE word_id = 'ASD-0265'").get().n;
    assert.equal(n, 1);
    const leftovers = fs.readdirSync(path.join(ctx.config.audioDir, 'basaa')).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('empty submission creates no row; unknown word → 404', async () => {
    const res = await putResponse(ctx.app, token, 'ASD-0300', { text: '   ' });
    assert.equal(res.statusCode, 200);
    assert.equal(row('ASD-0300'), undefined);
    const nf = await putResponse(ctx.app, token, 'ASD-9999', { text: 'x' });
    assert.equal(nf.statusCode, 404);
  });

  test('session reports progress and first pending word', async () => {
    const s = await startSession(ctx.app, 'dan@example.com', 'basaa');
    assert.equal(s.done_count, 3); // 0262, 0263, 0265
    assert.equal(s.first_pending_word_id, 'ASD-0264');
  });
});

describe('coverage-first word order', () => {
  let ctx;
  before(async () => { ctx = await makeApp(); });
  after(async () => { await ctx.cleanup(); });

  const getWords = async (token) => (await ctx.app.inject({
    url: '/collect/api/words', headers: { 'x-contributor-token': token },
  })).json();

  test('a newcomer starts on words nobody recorded yet in that language', async () => {
    const a = await startSession(ctx.app, 'first@example.com', 'ewondo');
    for (const id of ['ASD-0262', 'ASD-0263', 'ASD-0264']) await putResponse(ctx.app, a.token, id, { text: 'x' });
    // Another language does not count towards Ewondo coverage.
    const g = await startSession(ctx.app, 'other@example.com', 'ghomala');
    await putResponse(ctx.app, g.token, 'ASD-0265', { text: 'y' });

    const b = await startSession(ctx.app, 'second@example.com', 'ewondo');
    assert.equal(b.first_pending_word_id, 'ASD-0265');
    const { words, categories } = await getWords(b.token);
    assert.equal(words.length, 363);
    assert.equal(new Set(words.map((w) => w.id)).size, 363);
    assert.equal(words[0].id, 'ASD-0265');
    assert.deepEqual(words.slice(-3).map((w) => w.id), ['ASD-0262', 'ASD-0263', 'ASD-0264']);
    assert.equal(categories[0].name, 'Salutations');
    assert.equal(categories[0].first_word_id, 'ASD-0265');
  });

  test('own answers come first, then pending words by coverage', async () => {
    const b = await startSession(ctx.app, 'second@example.com', 'ewondo');
    await putResponse(ctx.app, b.token, 'ASD-0300', { text: 'z' });
    const s = await startSession(ctx.app, 'second@example.com', 'ewondo');
    assert.equal(s.done_count, 1);
    const { words } = await getWords(b.token);
    assert.equal(words[0].id, 'ASD-0300');
    assert.equal(words[0].text, 'z');
    assert.equal(words[1].id, s.first_pending_word_id);
    assert.equal(words[1].has_text, false);
  });
});

describe('validation', () => {
  let ctx, token;
  before(async () => {
    ctx = await makeApp({ MAX_AUDIO_MB: '1', MAX_TEXT_CHARS: '10' });
    ({ token } = await startSession(ctx.app));
  });
  after(async () => { await ctx.cleanup(); });

  test('bad email → 400', async () => {
    for (const email of ['nope', 'a@b', '', 'x'.repeat(250) + '@a.fr']) {
      const res = await ctx.app.inject({ method: 'POST', url: '/collect/api/session', payload: { email, language: 'basaa' } });
      assert.equal(res.statusCode, 400, email);
      assert.equal(res.json().error, 'invalid_email');
    }
  });

  test('unknown language → 400', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/collect/api/session', payload: { email: 'a@b.fr', language: 'french' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_language');
  });

  test('oversized audio → 413', async () => {
    const big = Buffer.concat([WEBM, Buffer.alloc(1024 * 1024 + 10)]);
    const res = await putResponse(ctx.app, token, 'ASD-0262', { audio: { data: big, type: 'audio/webm' } });
    assert.equal(res.statusCode, 413);
  });

  test('wrong magic bytes or MIME type → 415', async () => {
    let res = await putResponse(ctx.app, token, 'ASD-0262', { audio: { data: Buffer.from('not audio at all'), type: 'audio/webm' } });
    assert.equal(res.statusCode, 415);
    res = await putResponse(ctx.app, token, 'ASD-0262', { audio: { data: WEBM, type: 'video/webm' } });
    assert.equal(res.statusCode, 415);
    res = await putResponse(ctx.app, token, 'ASD-0262', { audio: { data: WEBM, type: 'audio/mp4' } });
    assert.equal(res.statusCode, 415);
    assert.equal(fs.existsSync(path.join(ctx.config.audioDir, 'basaa')), false, 'nothing written');
  });

  test('empty audio → 400', async () => {
    const res = await putResponse(ctx.app, token, 'ASD-0262', { audio: { data: Buffer.alloc(0), type: 'audio/webm' } });
    assert.equal(res.statusCode, 400);
  });

  test('text too long → 400', async () => {
    const res = await putResponse(ctx.app, token, 'ASD-0262', { text: 'abcdefghijk' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'text_too_long');
  });

  test('security headers are set', async () => {
    const res = await ctx.app.inject({ url: '/healthz' });
    assert.equal(res.json().ok, true);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'same-origin');
    assert.equal(res.headers['permissions-policy'], 'microphone=(self)');
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });
});
