import { readFile, unlink } from 'node:fs/promises';
import { requireUser } from '../auth.js';
import { saveUpload, mimeForPath, ensureThumb, thumbPathFor, UnsupportedMediaTypeError } from '../media.js';

const MEDIA_TTL_MS = 24 * 60 * 60 * 1000; // media messages expire 24h after send, both modes

function isMember(db, conversationId, userId) {
  return Boolean(
    db.prepare('SELECT 1 FROM participants WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId),
  );
}

function getParticipantIds(db, conversationId) {
  return db
    .prepare('SELECT user_id FROM participants WHERE conversation_id = ?')
    .all(conversationId)
    .map((row) => row.user_id);
}

// {viewable, viewed} for `message` (a media row) from `userId`'s point of
// view, per the self-destruct rules: the sender always sees their own media
// (never recorded as a view); a 'once' recipient can view exactly once
// before viewable flips false; a '24h' recipient can view freely until
// expiry. Callers must already know `message.kind !== 'text'`.
export function mediaFlags(db, message, userId) {
  if (message.sender_id === userId) {
    return { viewable: true, viewed: false };
  }
  const viewed = Boolean(
    db.prepare('SELECT 1 FROM media_views WHERE message_id = ? AND user_id = ?').get(message.id, userId),
  );
  const viewable = message.media_mode === '24h' ? true : !viewed;
  return { viewable, viewed };
}

function serializeMessage(row) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    kind: row.kind,
    body: row.body,
    media_mode: row.media_mode,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

export async function registerMediaRoutes(app) {
  app.post('/conversations/:id/media', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const conversationId = Number(request.params.id);
    if (!Number.isInteger(conversationId)) {
      return reply.code(400).send({ error: 'invalid_conversation_id' });
    }

    const conversation = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation_not_found' });
    }
    if (!isMember(db, conversationId, request.user.id)) {
      return reply.code(403).send({ error: 'not_a_member' });
    }

    // Not wrapped in try/catch: a fileSize-limit violation throws here (or
    // inside saveUpload below) and is left to propagate — @fastify/multipart
    // throws a RequestFileTooLargeError with statusCode 413 already attached,
    // which Fastify's default error handler turns straight into a 413.
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
    const expiresAt = now + MEDIA_TTL_MS;
    const info = db
      .prepare(
        `INSERT INTO messages (conversation_id, sender_id, kind, media_path, media_mode, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, request.user.id, saved.kind, saved.path, request.user.media_mode, now, expiresAt);

    const message = db
      .prepare(
        `SELECT id, conversation_id, sender_id, kind, body, media_mode, created_at, expires_at
         FROM messages WHERE id = ?`,
      )
      .get(info.lastInsertRowid);

    // Fire-and-forget — see the identical comment in routes/conversations.js.
    app.notifyNewMessage(conversationId, message).catch((err) => {
      request.log.error({ err }, 'notifyNewMessage failed');
    });

    return reply.code(201).send(serializeMessage(message));
  });

  app.get('/media/:messageId', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const messageId = Number(request.params.messageId);
    if (!Number.isInteger(messageId)) {
      return reply.code(400).send({ error: 'invalid_message_id' });
    }

    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    const now = Date.now();
    if (!message || message.kind === 'text' || message.expires_at <= now) {
      return reply.code(404).send({ error: 'not_found' });
    }

    if (!isMember(db, message.conversation_id, request.user.id)) {
      return reply.code(403).send({ error: 'not_a_member' });
    }

    const isSender = message.sender_id === request.user.id;

    // Record the view (idempotent — INSERT OR IGNORE — so a 24h recipient's
    // repeat views don't error) BEFORE reading the file. For 'once' mode
    // this insert-and-check-changes is the single atomic gate: two
    // concurrent/sequential requests from the same recipient can no longer
    // race between a separate "already viewed?" SELECT and the INSERT (the
    // previous shape had that gap spanning an `await readFile`, which meant
    // the same recipient could win the race and get the file twice). Only
    // the recipient whose INSERT actually wrote the row (changes === 1)
    // proceeds; everyone else — including a genuine second request — gets
    // rejected here, before ever touching the file.
    if (!isSender) {
      const insertResult = db
        .prepare('INSERT OR IGNORE INTO media_views (message_id, user_id, viewed_at) VALUES (?, ?, ?)')
        .run(messageId, request.user.id, now);
      if (message.media_mode === 'once' && insertResult.changes === 0) {
        return reply.code(403).send({ error: 'already_viewed' });
      }
    }

    // Read the file into memory AFTER the view is durably recorded (for
    // 'once') but BEFORE any deletion below, so the bytes we send back are
    // safe even if this call turns out to be the one that triggers the
    // unlink.
    const buffer = await readFile(message.media_path);

    if (!isSender && message.media_mode === 'once') {
      const recipientIds = getParticipantIds(db, message.conversation_id).filter(
        (id) => id !== message.sender_id,
      );
      const viewedCount = db
        .prepare('SELECT COUNT(DISTINCT user_id) AS c FROM media_views WHERE message_id = ?')
        .get(messageId).c;

      if (recipientIds.length > 0 && viewedCount >= recipientIds.length) {
        const deleteTx = db.transaction(() => {
          db.prepare('DELETE FROM media_views WHERE message_id = ?').run(messageId);
          db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
        });
        deleteTx();
        await unlink(message.media_path).catch(() => {});
        await unlink(thumbPathFor(message.media_path)).catch(() => {});
      }
    }

    return reply.type(mimeForPath(message.media_path)).send(buffer);
  });

  // In-bubble preview: a downscaled thumbnail that does NOT count as a view.
  // Only images, and only where previewing can't defeat the self-destruct
  // rules: the sender always may, a recipient only in '24h' mode (a 'once'
  // recipient gets 403 — their bubble keeps the tap-to-view chip, and the
  // real view still burns through GET /media/:id).
  app.get('/media/:messageId/thumb', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const messageId = Number(request.params.messageId);
    if (!Number.isInteger(messageId)) {
      return reply.code(400).send({ error: 'invalid_message_id' });
    }

    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!message || message.kind !== 'image' || message.expires_at <= Date.now()) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!isMember(db, message.conversation_id, request.user.id)) {
      return reply.code(403).send({ error: 'not_a_member' });
    }
    if (message.sender_id !== request.user.id && message.media_mode !== '24h') {
      return reply.code(403).send({ error: 'no_preview' });
    }

    const thumbPath = await ensureThumb(message.media_path);
    const servePath = thumbPath || message.media_path;
    const buffer = await readFile(servePath);
    reply.header('cache-control', 'private, max-age=86400');
    return reply.type(thumbPath ? 'image/webp' : mimeForPath(message.media_path)).send(buffer);
  });
}
