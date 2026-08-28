import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { makeTestDb } from './helpers.js';

const ALL_TABLES = [
  'conversations',
  'invites',
  'media_views',
  'messages',
  'participants',
  'push_subs',
  'stories',
  'story_views',
  'users',
];

describe('createDb', () => {
  it('creates the sqlite file under <dataDir>/db and the media dir under <dataDir>/media', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lazybutts-test-'));

    const { mediaDir } = createDb(dataDir);

    expect(existsSync(join(dataDir, 'db', 'lazybutts.sqlite3'))).toBe(true);
    expect(mediaDir).toBe(join(dataDir, 'media'));
    expect(existsSync(mediaDir)).toBe(true);
  });

  it('enables WAL journal mode', () => {
    const { db } = makeTestDb();

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('creates all 9 tables defined in schema.sql', () => {
    const { db } = makeTestDb();

    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);

    expect(names).toEqual(ALL_TABLES);
  });

  it('is idempotent: running schema.sql twice against the same dataDir does not throw', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lazybutts-test-'));

    createDb(dataDir);

    expect(() => createDb(dataDir)).not.toThrow();
  });
});

describe('users table', () => {
  it('inserts a user and applies column defaults', () => {
    const { db } = makeTestDb();
    const now = Date.now();

    const info = db
      .prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
      .run('alice', 'hashed-pw', now);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

    expect(user.username).toBe('alice');
    expect(user.is_admin).toBe(0);
    expect(user.media_mode).toBe('once');
    expect(user.created_at).toBe(now);
  });

  it('rejects a duplicate username', () => {
    const { db } = makeTestDb();
    const now = Date.now();
    db.prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)').run(
      'bob',
      'hashed-pw',
      now,
    );

    expect(() =>
      db
        .prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
        .run('bob', 'other-hash', now),
    ).toThrow(/UNIQUE/);
  });

  it('rejects an invalid media_mode value via the CHECK constraint', () => {
    const { db } = makeTestDb();
    const now = Date.now();

    expect(() =>
      db
        .prepare(
          'INSERT INTO users (username, pass_hash, media_mode, created_at) VALUES (?, ?, ?, ?)',
        )
        .run('carol', 'hashed-pw', 'weekly', now),
    ).toThrow(/CHECK/);
  });
});

describe('messages table', () => {
  it('rejects an invalid kind value via the CHECK constraint', () => {
    const { db } = makeTestDb();
    const now = Date.now();

    expect(() =>
      db
        .prepare(
          `INSERT INTO messages (conversation_id, sender_id, kind, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(1, 1, 'audio', now, now + 1000),
    ).toThrow(/CHECK/);
  });

  it('rejects an invalid media_mode value via the CHECK constraint', () => {
    const { db } = makeTestDb();
    const now = Date.now();

    expect(() =>
      db
        .prepare(
          `INSERT INTO messages (conversation_id, sender_id, kind, media_mode, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(1, 1, 'image', 'weekly', now, now + 1000),
    ).toThrow(/CHECK/);
  });
});

describe('loadConfig', () => {
  it('throws when SESSION_SECRET is missing', () => {
    expect(() => loadConfig({})).toThrow(/SESSION_SECRET/);
  });

  it('applies documented defaults', () => {
    const config = loadConfig({ SESSION_SECRET: 'shh' });

    expect(config.port).toBe(8082);
    expect(config.dataDir).toBe('/data');
    expect(config.sessionSecret).toBe('shh');
    expect(config.maxUploadBytes).toBe(50 * 1024 * 1024);
    expect(config.vapid).toBeNull();
  });

  it('reads PORT, DATA_DIR and MAX_UPLOAD_MB overrides from env', () => {
    const config = loadConfig({
      SESSION_SECRET: 'shh',
      PORT: '3000',
      DATA_DIR: '/tmp/lazybutts-data',
      MAX_UPLOAD_MB: '10',
    });

    expect(config.port).toBe(3000);
    expect(config.dataDir).toBe('/tmp/lazybutts-data');
    expect(config.maxUploadBytes).toBe(10 * 1024 * 1024);
  });

  it('builds the vapid config only when all three vars are present', () => {
    const config = loadConfig({
      SESSION_SECRET: 'shh',
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:admin@example.com',
    });

    expect(config.vapid).toEqual({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:admin@example.com',
    });
  });

  it('leaves vapid null when only some vapid vars are present', () => {
    const config = loadConfig({ SESSION_SECRET: 'shh', VAPID_PUBLIC_KEY: 'pub' });

    expect(config.vapid).toBeNull();
  });
});
