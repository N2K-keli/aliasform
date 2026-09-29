import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, startSession, putResponse, adminAuth, WEBM } from './helpers.js';
import { csvCell } from '../src/routes/admin.js';

// Precomposed letters plus decomposed sequences (e + combining acute, o + combining circumflex,
// a + combining grave, ɛ + combining tilde) that NFC must compose where possible.
const DIACRITICS_RAW = 'ɛ ɔ ŋ ə ɨ ʉ é ô é ô à ɛ̃ ō';
const DIACRITICS = DIACRITICS_RAW.normalize('NFC');

describe('admin', () => {
  let ctx, token;
  before(async () => {
    ctx = await makeApp();
    ({ token } = await startSession(ctx.app, 'eve@example.com', 'ghomala'));
    await putResponse(ctx.app, token, 'ASD-0262', { audio: { data: WEBM, type: 'audio/webm' }, text: DIACRITICS_RAW });
    await putResponse(ctx.app, token, 'ASD-0263', { text: '=HYPERLINK("http://evil")' });
  });
  after(async () => { await ctx.cleanup(); });

  test('401 without credentials, with the Basic challenge', async () => {
    for (const url of ['/adminView', '/adminView/api/stats', '/adminView/assets/admin.js', '/adminView/api/export.csv']) {
      const res = await ctx.app.inject({ url });
      assert.equal(res.statusCode, 401, url);
      assert.equal(res.headers['www-authenticate'], 'Basic realm="Admin", charset="UTF-8"');
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    const wrong = await ctx.app.inject({ url: '/adminView/api/stats', headers: adminAuth('admin', 'nope') });
    assert.equal(wrong.statusCode, 401);
  });

  test('200 with credentials; no-store; admin.js not public', async () => {
    const res = await ctx.app.inject({ url: '/adminView', headers: adminAuth() });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /\/adminView\/assets\/admin\.js/);
    const pub = await ctx.app.inject({ url: '/collect/assets/admin.js' });
    assert.equal(pub.statusCode, 404);
  });

  test('stats', async () => {
    const res = await ctx.app.inject({ url: '/adminView/api/stats', headers: adminAuth() });
    const g = res.json().languages.find((l) => l.language === 'ghomala');
    assert.deepEqual(g, {
      language: 'ghomala', label: 'Ghomala de Bandjoun', contributors: 1, responses: 2,
      with_audio: 1, with_text: 2, words_covered: 1, total_words: 363,
    });
  });

  test('diacritics round trip through API, list and CSV', async () => {
    const words = await ctx.app.inject({ url: '/collect/api/words', headers: { 'x-contributor-token': token } });
    assert.equal(words.json().words.find((w) => w.id === 'ASD-0262').text, DIACRITICS);

    const list = await ctx.app.inject({ url: '/adminView/api/responses?has_audio=1', headers: adminAuth() });
    const body = list.json();
    assert.equal(body.total, 1);
    assert.equal(body.rows[0].text, DIACRITICS);
    assert.equal(body.rows[0].email, 'eve@example.com');

    const csv = await ctx.app.inject({ url: '/adminView/api/export.csv', headers: adminAuth() });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.headers['content-type'], /text\/csv; charset=utf-8/);
    assert.deepEqual([...csv.rawPayload.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with UTF-8 BOM');
    const text = csv.rawPayload.toString('utf8');
    assert.ok(text.includes(DIACRITICS));
    assert.ok(text.includes('\r\n'));
    assert.ok(text.includes('audio/ghomala/ASD-0262__c1.webm'));
  });

  test('CSV injection protection', async () => {
    const csv = await ctx.app.inject({ url: '/adminView/api/export.csv', headers: adminAuth() });
    assert.ok(csv.body.includes(`"'=HYPERLINK(""http://evil"")"`));
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('-x'), "'-x");
    assert.equal(csvCell('@a'), "'@a");
    assert.equal(csvCell('\tx'), "'\tx");
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('ok'), 'ok');
  });

  test('filters and search (accent-insensitive)', async () => {
    const get = async (qs) => (await ctx.app.inject({ url: `/adminView/api/responses?${qs}`, headers: adminAuth() })).json();
    assert.equal((await get('q=PLAIT')).total, 1);
    assert.equal((await get('language=basaa')).total, 0);
    assert.equal((await get('category=Salutations&has_text=1')).total, 2);
    assert.equal((await get('page_size=1&page=2')).rows.length, 1);
    const bad = await ctx.app.inject({ url: '/adminView/api/responses?language=xx', headers: adminAuth() });
    assert.equal(bad.statusCode, 400);
  });

  test('audio streaming with Range', async () => {
    const id = ctx.app.db.prepare("SELECT id FROM responses WHERE word_id = 'ASD-0262'").get().id;
    const res = await ctx.app.inject({ url: `/adminView/api/audio/${id}`, headers: { ...adminAuth(), range: 'bytes=2-' } });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-type'], 'audio/webm');
    assert.deepEqual(res.rawPayload, WEBM.subarray(2));
    const none = await ctx.app.inject({ url: '/adminView/api/audio/99999', headers: adminAuth() });
    assert.equal(none.statusCode, 404);
  });

  test('ZIP export', async () => {
    const res = await ctx.app.inject({ url: '/adminView/api/export.zip?language=ghomala', headers: adminAuth() });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.match(res.headers['content-disposition'], /aila-export-ghomala-\d{8}\.zip/);
    assert.equal(res.rawPayload.subarray(0, 2).toString(), 'PK');
    const raw = res.rawPayload.toString('latin1');
    assert.ok(raw.includes('manifest.csv'));
    assert.ok(raw.includes('audio/ghomala/ASD-0262__c1.webm'));
  });

  test('failed logins are rate limited', async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await ctx.app.inject({ url: '/adminView/api/stats', headers: adminAuth('admin', 'bad'), remoteAddress: '10.9.9.9' });
    }
    assert.equal(last.statusCode, 429);
    const good = await ctx.app.inject({ url: '/adminView/api/stats', headers: adminAuth(), remoteAddress: '10.9.9.9' });
    assert.equal(good.statusCode, 429, 'locked even with the right password');
  });
});
