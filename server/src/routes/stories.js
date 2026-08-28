import { readFile } from 'node:fs/promises';
import { requireUser } from '../auth.js';
import { saveUpload, mimeForPath, UnsupportedMediaTypeError } from '../media.js';

const STORY_TTL_MS = 24 * 60 * 60 * 1000; // stories expire 24h after posting

export async function registerStoryRoutes(app) {
  app.post('/stories', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;

    // Not wrapped in try/catch here on purpose — see media.js's identical
    // comment: a fileSize-limit violation propagates as a 413 untouched.
    const part = await request.file();
    if (!part) {
      return reply.code(400).send({ error: 'file_required' });
    }

    let saved;
    try {
      saved = await saveUpload(part, app.mediaDir);
    } catch (err) {
      if (err instanceof UnsupportedMediaTypeError) {
        return reply.code(415).send({ error: 'unsupported_media_type' });
      }
      throw err;
    }

    const now = Date.now();
    const expiresAt = now + STORY_TTL_MS;
    const info = db
      .prepare(
        `INSERT INTO stories (user_id, kind, media_path, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(request.user.id, saved.kind, saved.path, now, expiresAt);

    const story = db
      .prepare('SELECT id, user_id, kind, created_at, expires_at FROM stories WHERE id = ?')
      .get(info.lastInsertRowid);

    await app.notifyNewStory(request.user.id, story.id);

    return reply.code(201).send(story);
  });

  // Grouped by poster (including the caller's own stories), newest story
  // first within each group; expired stories are filtered out entirely.
  app.get('/stories', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const now = Date.now();

    const rows = db
      .prepare(
        `SELECT s.id, s.user_id, s.kind, s.created_at, u.username
         FROM stories s
         JOIN users u ON u.id = s.user_id
         WHERE s.expires_at > ?
         ORDER BY s.user_id ASC, s.created_at ASC`,
      )
      .all(now);

    const viewedStmt = db.prepare('SELECT 1 FROM story_views WHERE story_id = ? AND user_id = ?');

    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.user_id)) {
        groups.set(row.user_id, { user: { id: row.user_id, username: row.username }, stories: [] });
      }
      groups.get(row.user_id).stories.push({
        id: row.id,
        kind: row.kind,
        created_at: row.created_at,
        viewed: Boolean(viewedStmt.get(row.id, request.user.id)),
      });
    }

    return reply.send([...groups.values()]);
  });

  app.get('/stories/:id/media', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const storyId = Number(request.params.id);
    if (!Number.isInteger(storyId)) {
      return reply.code(400).send({ error: 'invalid_story_id' });
    }

    const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(storyId);
    const now = Date.now();
    if (!story || story.expires_at <= now) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const buffer = await readFile(story.media_path);

    db.prepare(
      'INSERT OR IGNORE INTO story_views (story_id, user_id, viewed_at) VALUES (?, ?, ?)',
    ).run(storyId, request.user.id, now);

    return reply.type(mimeForPath(story.media_path)).send(buffer);
  });
}
