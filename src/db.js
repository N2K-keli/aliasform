import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS words (
  id             TEXT PRIMARY KEY,
  category       TEXT NOT NULL,
  category_order INTEGER NOT NULL,
  position       INTEGER NOT NULL,
  french_text    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contributors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL,
  language     TEXT NOT NULL CHECK (language IN ('ewondo','basaa','ghomala')),
  token        TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (email, language)
);

CREATE TABLE IF NOT EXISTS responses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  word_id        TEXT NOT NULL REFERENCES words(id),
  audio_path     TEXT,
  audio_mime     TEXT,
  audio_bytes    INTEGER,
  text           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (contributor_id, word_id),
  CHECK (audio_path IS NOT NULL OR text IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_responses_word ON responses(word_id);
CREATE INDEX IF NOT EXISTS idx_contributors_lang ON contributors(language);
`;

/** Opens (and creates if needed) the SQLite database with the app schema. */
export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();

/** Prepared statements used by the routes. */
export function prepareStatements(db) {
  return {
    ping: db.prepare('SELECT 1 AS ok'),
    allWords: db.prepare('SELECT id, category, category_order, position, french_text FROM words ORDER BY position'),
    getWord: db.prepare('SELECT id, category, french_text FROM words WHERE id = ?'),

    getContributorByPair: db.prepare('SELECT * FROM contributors WHERE email = ? AND language = ?'),
    getContributorByToken: db.prepare('SELECT * FROM contributors WHERE token = ?'),
    insertContributor: db.prepare(
      'INSERT INTO contributors (email, language, token, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
    ),
    touchContributor: db.prepare('UPDATE contributors SET last_seen_at = ? WHERE id = ?'),

    doneCount: db.prepare('SELECT COUNT(*) AS n FROM responses WHERE contributor_id = ?'),
    firstPending: db.prepare(`
      SELECT w.id FROM words w
      WHERE NOT EXISTS (SELECT 1 FROM responses r WHERE r.word_id = w.id AND r.contributor_id = ?)
      ORDER BY w.position LIMIT 1`),
    contributorResponses: db.prepare('SELECT word_id, audio_path, text FROM responses WHERE contributor_id = ?'),
    getResponse: db.prepare('SELECT * FROM responses WHERE contributor_id = ? AND word_id = ?'),
    getResponseById: db.prepare(`
      SELECT r.*, c.language FROM responses r JOIN contributors c ON c.id = r.contributor_id WHERE r.id = ?`),
    upsertResponse: db.prepare(`
      INSERT INTO responses (contributor_id, word_id, audio_path, audio_mime, audio_bytes, text, created_at, updated_at)
      VALUES (@contributor_id, @word_id, @audio_path, @audio_mime, @audio_bytes, @text, @now, @now)
      ON CONFLICT (contributor_id, word_id) DO UPDATE SET
        audio_path = excluded.audio_path,
        audio_mime = excluded.audio_mime,
        audio_bytes = excluded.audio_bytes,
        text = excluded.text,
        updated_at = excluded.updated_at`),
    deleteResponse: db.prepare('DELETE FROM responses WHERE contributor_id = ? AND word_id = ?'),
  };
}
