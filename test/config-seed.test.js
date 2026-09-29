import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seedWords, readWordsCsv } from '../scripts/seed.js';
import { makeApp, startSession, adminAuth, tempDir } from './helpers.js';

describe('base paths', () => {
  test('PUBLIC_PATH=/x and ADMIN_PATH=/y move the routes', async () => {
    const ctx = await makeApp({ PUBLIC_PATH: 'x/', ADMIN_PATH: '/y' });
    try {
      const { app } = ctx;
      const root = await app.inject({ url: '/' });
      assert.equal(root.statusCode, 302);
      assert.equal(root.headers.location, '/x');

      const page = await app.inject({ url: '/x' });
      assert.equal(page.statusCode, 200);
      assert.ok(page.body.includes('/x/assets/collect.js'));
      assert.ok(page.body.includes('"basePath":"/x"'));
      assert.ok(!/\/collect(?!\.js)/.test(page.body), 'no hard-coded /collect path');
      assert.ok(!page.body.includes('__BASE_PATH__') && !page.body.includes('__CONFIG__'));

      const s = await startSession(app, 'p@example.com', 'ewondo', '/x');
      assert.match(s.token, /^[0-9a-f]{64}$/);
      assert.equal((await app.inject({ method: 'POST', url: '/collect/api/session', payload: {} })).statusCode, 404);

      assert.equal((await app.inject({ url: '/y' })).statusCode, 401);
      assert.equal((await app.inject({ url: '/y/api/stats', headers: adminAuth() })).statusCode, 200);
      assert.equal((await app.inject({ url: '/adminView', headers: adminAuth() })).statusCode, 404);
      assert.equal((await app.inject({ url: '/healthz' })).statusCode, 200);
    } finally {
      await ctx.cleanup();
    }
  });

  test('config validation', () => {
    assert.throws(() => loadConfig({}), /ADMIN_PASSWORD/);
    assert.throws(() => loadConfig({ ADMIN_PASSWORD: 'change-me', NODE_ENV: 'production' }), /change-me/);
    assert.doesNotThrow(() => loadConfig({ ADMIN_PASSWORD: 'change-me', NODE_ENV: 'development' }));
    const c = loadConfig({ ADMIN_PASSWORD: 'x', PUBLIC_PATH: 'abc///' });
    assert.equal(c.publicPath, '/abc');
    assert.equal(c.adminPath, '/adminView');
  });
});

describe('seed', () => {
  test('idempotent; repeated French texts under different ids are all kept', () => {
    const dir = tempDir();
    const db = openDb(path.join(dir, 'app.db'));
    try {
      const first = seedWords(db);
      const second = seedWords(db);
      assert.equal(first.total, 363);
      assert.equal(second.total, 363);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM words').get().n, 363);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM words WHERE french_text = 'Riz'").get().n, 2);
      assert.ok(db.prepare("SELECT COUNT(*) AS n FROM words WHERE french_text = 'Merci'").get().n > 1);
      assert.equal(first.perCategory.get('Famille'), 133);
      assert.equal(first.perCategory.has('Vêtements'), false);
      const firstWord = db.prepare('SELECT * FROM words WHERE position = 1').get();
      assert.equal(firstWord.id, 'ASD-0262');
      assert.equal(firstWord.category_order, 1);
      const last = db.prepare('SELECT * FROM words ORDER BY position DESC LIMIT 1').get();
      assert.equal(last.id, 'ASD-0363');
      assert.equal(last.category, 'École');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fills empty categories from ID ranges, appends unknown categories, rejects bad rows', () => {
    const dir = tempDir();
    const file = path.join(dir, 'w.csv');
    try {
      fs.writeFileSync(file, 'id,category,french_text\nASD-0001,,Singe\nASD-0500,Nouvelle,"Un, deux"\nASD-0262,Salutations,  Bonjour  \n');
      const words = readWordsCsv(file);
      assert.deepEqual(words.map((w) => [w.id, w.category, w.position]), [
        ['ASD-0262', 'Salutations', 1], ['ASD-0001', 'Animaux', 2], ['ASD-0500', 'Nouvelle', 3],
      ]);
      assert.equal(words[0].french_text, 'Bonjour');
      assert.equal(words[2].french_text, 'Un, deux');

      fs.writeFileSync(file, 'id,category,french_text\nASD-0001,Animaux,A\nASD-0001,Animaux,B\n');
      assert.throws(() => readWordsCsv(file), /duplicate/);
      fs.writeFileSync(file, 'id,category,french_text\nX-1,Animaux,A\n');
      assert.throws(() => readWordsCsv(file), /invalid id/);
      fs.writeFileSync(file, 'id,category,french_text\nASD-0001,Animaux,  \n');
      assert.throws(() => readWordsCsv(file), /empty french_text/);
      fs.writeFileSync(file, 'id,category,french_text\nASD-0999,,Texte\n');
      assert.throws(() => readWordsCsv(file), /outside every known range/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sample CSV is valid', () => {
    const words = readWordsCsv(new URL('../seed/words.sample.csv', import.meta.url));
    assert.equal(words.length, 10);
  });
});
