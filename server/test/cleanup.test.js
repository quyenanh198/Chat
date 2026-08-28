import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCleanup, startCleanup } from '../src/cleanup.js';
import { makeTestDb } from './helpers.js';

function makeFile(mediaDir, name) {
  const path = join(mediaDir, name);
  writeFileSync(path, 'fake-bytes');
  return path;
}

function insertUser(db, username) {
  return db
    .prepare(`INSERT INTO users (username, pass_hash, created_at) VALUES (?, 'hash', ?)`)
    .run(username, Date.now()).lastInsertRowid;
}

function insertConversation(db) {
  return db.prepare('INSERT INTO conversations (is_group, created_at) VALUES (0, ?)').run(Date.now())
    .lastInsertRowid;
}

function insertTextMessage(db, { conversationId, senderId, expiresAt }) {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO messages (conversation_id, sender_id, kind, body, created_at, expires_at)
       VALUES (?, ?, 'text', 'hello', ?, ?)`,
    )
    .run(conversationId, senderId, now, expiresAt).lastInsertRowid;
}

function insertMediaMessage(db, { conversationId, senderId, mediaPath, expiresAt }) {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO messages (conversation_id, sender_id, kind, media_path, media_mode, created_at, expires_at)
       VALUES (?, ?, 'image', ?, 'once', ?, ?)`,
    )
    .run(conversationId, senderId, mediaPath, now, expiresAt).lastInsertRowid;
}

function insertStory(db, { userId, mediaPath, expiresAt }) {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO stories (user_id, kind, media_path, created_at, expires_at) VALUES (?, 'image', ?, ?, ?)`,
    )
    .run(userId, mediaPath, now, expiresAt).lastInsertRowid;
}

describe('runCleanup', () => {
  it('deletes an expired text message and keeps one not yet expired', async () => {
    const { db } = makeTestDb();
    const senderId = insertUser(db, 'alice');
    const conversationId = insertConversation(db);
    const now = Date.now();
    const expiredId = insertTextMessage(db, { conversationId, senderId, expiresAt: now - 1 });
    const aliveId = insertTextMessage(db, { conversationId, senderId, expiresAt: now + 100_000 });

    await runCleanup(db, '/unused-media-dir');

    expect(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(expiredId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(aliveId)).toBeTruthy();
  });

  it('unlinks the file and deletes the row for an expired media message', async () => {
    const { db, mediaDir } = makeTestDb();
    const senderId = insertUser(db, 'alice');
    const conversationId = insertConversation(db);
    const filePath = makeFile(mediaDir, 'expired.png');
    const messageId = insertMediaMessage(db, { conversationId, senderId, mediaPath: filePath, expiresAt: Date.now() - 1 });

    expect(existsSync(filePath)).toBe(true);

    await runCleanup(db, mediaDir);

    expect(existsSync(filePath)).toBe(false);
    expect(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId)).toBeUndefined();
  });

  it('leaves a not-yet-expired media message and its file untouched', async () => {
    const { db, mediaDir } = makeTestDb();
    const senderId = insertUser(db, 'alice');
    const conversationId = insertConversation(db);
    const filePath = makeFile(mediaDir, 'alive.png');
    const messageId = insertMediaMessage(db, {
      conversationId,
      senderId,
      mediaPath: filePath,
      expiresAt: Date.now() + 100_000,
    });

    await runCleanup(db, mediaDir);

    expect(existsSync(filePath)).toBe(true);
    expect(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId)).toBeTruthy();
  });

  it('unlinks the file and deletes the row for an expired story, keeping a live one', async () => {
    const { db, mediaDir } = makeTestDb();
    const userId = insertUser(db, 'alice');
    const expiredPath = makeFile(mediaDir, 'expired-story.png');
    const alivePath = makeFile(mediaDir, 'alive-story.png');
    const expiredId = insertStory(db, { userId, mediaPath: expiredPath, expiresAt: Date.now() - 1 });
    const aliveId = insertStory(db, { userId, mediaPath: alivePath, expiresAt: Date.now() + 100_000 });

    await runCleanup(db, mediaDir);

    expect(existsSync(expiredPath)).toBe(false);
    expect(existsSync(alivePath)).toBe(true);
    expect(db.prepare('SELECT 1 FROM stories WHERE id = ?').get(expiredId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM stories WHERE id = ?').get(aliveId)).toBeTruthy();
  });

  it('sweeps media_views/story_views rows left with no parent row at all', async () => {
    const { db, mediaDir } = makeTestDb();
    const userId = insertUser(db, 'alice');
    // No message/story with id 999 was ever inserted.
    db.prepare('INSERT INTO media_views (message_id, user_id, viewed_at) VALUES (999, ?, ?)').run(userId, Date.now());
    db.prepare('INSERT INTO story_views (story_id, user_id, viewed_at) VALUES (999, ?, ?)').run(userId, Date.now());

    await runCleanup(db, mediaDir);

    expect(db.prepare('SELECT COUNT(*) AS c FROM media_views').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM story_views').get().c).toBe(0);
  });

  it('keeps a view row whose parent message/story is still alive', async () => {
    const { db, mediaDir } = makeTestDb();
    const senderId = insertUser(db, 'alice');
    const viewerId = insertUser(db, 'bob');
    const conversationId = insertConversation(db);
    const filePath = makeFile(mediaDir, 'live.png');
    const messageId = insertMediaMessage(db, {
      conversationId,
      senderId,
      mediaPath: filePath,
      expiresAt: Date.now() + 100_000,
    });
    db.prepare('INSERT INTO media_views (message_id, user_id, viewed_at) VALUES (?, ?, ?)').run(
      messageId,
      viewerId,
      Date.now(),
    );

    await runCleanup(db, mediaDir);

    expect(db.prepare('SELECT 1 FROM media_views WHERE message_id = ?').get(messageId)).toBeTruthy();
    expect(existsSync(filePath)).toBe(true);
  });

  it('tolerates a media_path that no longer exists on disk (already gone)', async () => {
    const { db, mediaDir } = makeTestDb();
    const senderId = insertUser(db, 'alice');
    const conversationId = insertConversation(db);
    const missingPath = join(mediaDir, 'never-written.png');
    const messageId = insertMediaMessage(db, {
      conversationId,
      senderId,
      mediaPath: missingPath,
      expiresAt: Date.now() - 1,
    });

    await expect(runCleanup(db, mediaDir)).resolves.toBeUndefined();
    expect(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId)).toBeUndefined();
  });
});

describe('startCleanup', () => {
  it('runs a cleanup pass every intervalMs until stop() is called', async () => {
    const { db, mediaDir } = makeTestDb();
    const senderId = insertUser(db, 'alice');
    const conversationId = insertConversation(db);
    const expiredId = insertTextMessage(db, { conversationId, senderId, expiresAt: Date.now() - 1 });

    const stop = startCleanup(db, mediaDir, 20);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(expiredId)).toBeUndefined();
    } finally {
      stop();
    }
  });

  it('stop() prevents any further cleanup pass', async () => {
    const { db, mediaDir } = makeTestDb();
    const stop = startCleanup(db, mediaDir, 20);
    stop();

    const senderId = insertUser(db, 'alice');
    const conversationId = insertConversation(db);
    const expiredId = insertTextMessage(db, { conversationId, senderId, expiresAt: Date.now() - 1 });

    await new Promise((resolve) => setTimeout(resolve, 80));

    // The interval was stopped before this row even existed, so nothing
    // could have swept it — it must still be there.
    expect(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(expiredId)).toBeTruthy();
  });
});
