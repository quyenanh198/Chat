import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

// Opens (creating if needed) the sqlite DB at <dataDir>/db/lazybutts.sqlite3,
// ensures <dataDir>/media exists, enables WAL mode, and applies schema.sql
// (idempotent: every statement is CREATE TABLE IF NOT EXISTS).
export function createDb(dataDir) {
  const dbDir = join(dataDir, 'db');
  const mediaDir = join(dataDir, 'media');
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });

  const dbPath = join(dbDir, 'lazybutts.sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  return { db, mediaDir };
}
