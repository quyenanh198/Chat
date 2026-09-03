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

  // Lightweight migration for DBs created before display_name existed.
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('display_name')) {
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  }
  // Thông báo game (farm) tách riêng, bật/tắt trong Cài đặt — mặc định bật.
  if (!userCols.includes('farm_notify')) {
    db.exec('ALTER TABLE users ADD COLUMN farm_notify INTEGER NOT NULL DEFAULT 1');
  }
  if (!userCols.includes('avatar_at')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar_at INTEGER');
  }
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!msgCols.includes('reply_to')) {
    db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
  }
  if (!msgCols.includes('edited_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
  }
  // Groups created before this column existed keep NULL: only an admin can
  // remove members from those (see the members routes in conversations.js).
  const convCols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  if (!convCols.includes('created_by')) {
    db.exec('ALTER TABLE conversations ADD COLUMN created_by INTEGER');
  }

  return { db, mediaDir };
}
