import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const KEEP = 14;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const dbFile = path.join(dataDir, 'app.db');
const backupDir = path.join(dataDir, 'backups');

if (!fs.existsSync(dbFile)) {
  console.error(`No database found at ${dbFile}`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });
const target = path.join(backupDir, `app-${stamp()}.db`);

const db = new Database(dbFile, { readonly: true, fileMustExist: true });
try {
  await db.backup(target);
  console.log(`Backup written: ${target}`);
} finally {
  db.close();
}

const backups = fs.readdirSync(backupDir)
  .filter((f) => /^app-\d{8}-\d{4}\.db$/.test(f))
  .sort()
  .reverse();
for (const old of backups.slice(KEEP)) {
  fs.unlinkSync(path.join(backupDir, old));
  console.log(`Deleted old backup: ${old}`);
}
