import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { openDb } from '../src/db.js';
import { categoryFromId, orderWords } from '../src/categories.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CSV = path.join(ROOT, 'seed', 'words.csv');
export const EXPECTED_TOTAL = 363;

/** Parses and validates the word CSV. Returns ordered words. Throws on invalid data. */
export function readWordsCsv(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, { bom: true, skip_empty_lines: true, relax_column_count: false });
  if (rows.length === 0) throw new Error('CSV is empty');

  const header = rows[0].map((h) => h.trim());
  if (header.join(',') !== 'id,category,french_text') {
    throw new Error(`Unexpected CSV header: ${header.join(',')} (expected id,category,french_text)`);
  }

  const seen = new Set();
  const words = rows.slice(1).map((row, i) => {
    const line = i + 2;
    const id = row[0].trim();
    let category = row[1].trim().normalize('NFC');
    const french_text = row[2].trim().normalize('NFC');
    if (!/^ASD-\d{4}$/.test(id)) throw new Error(`Line ${line}: invalid id "${id}"`);
    if (seen.has(id)) throw new Error(`Line ${line}: duplicate id ${id}`);
    seen.add(id);
    if (!french_text) throw new Error(`Line ${line}: empty french_text for ${id}`);
    if (!category) {
      category = categoryFromId(id);
      if (!category) throw new Error(`Line ${line}: empty category and ${id} is outside every known range`);
    }
    return { id, category, french_text };
  });
  return orderWords(words);
}

/** Idempotent upsert of the word list in one transaction. Never deletes words. */
export function seedWords(db, csvPath = DEFAULT_CSV) {
  const words = readWordsCsv(csvPath);
  const upsert = db.prepare(`
    INSERT INTO words (id, category, category_order, position, french_text)
    VALUES (@id, @category, @category_order, @position, @french_text)
    ON CONFLICT (id) DO UPDATE SET
      category = excluded.category,
      category_order = excluded.category_order,
      position = excluded.position,
      french_text = excluded.french_text`);
  db.transaction(() => { for (const w of words) upsert.run(w); })();

  const perCategory = new Map();
  for (const w of words) perCategory.set(w.category, (perCategory.get(w.category) || 0) + 1);
  return { total: words.length, perCategory };
}

export function printSummary({ total, perCategory }, log = console.log) {
  log(`Mots importés : ${total}`);
  for (const [name, count] of perCategory) log(`  ${name}: ${count}`);
  if (total !== EXPECTED_TOTAL) log(`ATTENTION : ${total} mots au lieu de ${EXPECTED_TOTAL} attendus.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const csvPath = path.resolve(process.argv[2] || DEFAULT_CSV);
  const dataDir = path.resolve(process.env.DATA_DIR || './data');
  const db = openDb(path.join(dataDir, 'app.db'));
  try {
    printSummary(seedWords(db, csvPath));
  } catch (err) {
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
