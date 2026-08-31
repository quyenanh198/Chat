import { requireUser } from '../auth.js';
import { mediaFlags } from './media.js';

const TEXT_TTL_MS = 24 * 60 * 60 * 1000; // text messages expire 24h after send

// Loads {id, username} for every participant of a conversation, ordered by id.
function getParticipants(db, conversationId) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_at FROM participants p
       JOIN users u ON u.id = p.user_id
       WHERE p.conversation_id = ?
       ORDER BY u.id`,
    )
    .all(conversationId);
}

function isMember(db, conversationId, userId) {
  return Boolean(
    db.prepare('SELECT 1 FROM participants WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId),
  );
}

// Most recent non-expired message in the conversation, meta-only: media
// messages never carry their body/file here, just enough to render a
// preview line ("📷 Photo" etc. is a frontend concern).
function getLastMessage(db, conversationId, now) {
  const row = db
    .prepare(
      `SELECT id, sender_id, kind, body, created_at FROM messages
       WHERE conversation_id = ? AND expires_at > ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(conversationId, now);

  if (!row) return null;

  return {
    id: row.id,
    sender_id: row.sender_id,
    kind: row.kind,
    created_at: row.created_at,
    body: row.kind === 'text' ? row.body : null,
  };
}

function serializeConversation(db, conversation, now) {
  return {
    id: conversation.id,
    is_group: Boolean(conversation.is_group),
    name: conversation.name,
    created_at: conversation.created_at,
    participants: getParticipants(db, conversation.id),
    last_message: getLastMessage(db, conversation.id, now),
    // MVP: unread state needs a per-user read-marker table, which is out of
    // scope for this task. Always 0 so the frontend field never breaks;
    // TODO(task-future): compute a real unread count once read-state exists.
    unread_count: 0,
  };
}

// Aggregates reactions for a set of message ids as [{emoji, count, mine}] per message.
function reactionsByMessage(db, messageIds, meId) {
  const out = new Map();
  if (messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT r.message_id, r.emoji, COUNT(*) AS count,
              MAX(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) AS mine,
              GROUP_CONCAT(COALESCE(u.display_name, u.username), CHAR(31)) AS names
       FROM message_reactions r JOIN users u ON u.id = r.user_id
       WHERE r.message_id IN (${placeholders})
       GROUP BY r.message_id, r.emoji ORDER BY MIN(r.created_at)`,
    )
    .all(meId, ...messageIds);
  for (const r of rows) {
    if (!out.has(r.message_id)) out.set(r.message_id, []);
    out.get(r.message_id).push({
      emoji: r.emoji,
      count: r.count,
      mine: !!r.mine,
      names: r.names ? r.names.split(String.fromCharCode(31)) : [],
    });
  }
  return out;
}

export async function registerConversationRoutes(app) {
  app.post('/conversations', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const { user_ids, name } = request.body ?? {};

    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return reply.code(400).send({ error: 'user_ids_required' });
    }

    const otherIds = [...new Set(user_ids.map(Number))].filter(
      (id) => Number.isInteger(id) && id !== request.user.id,
    );
    if (otherIds.length === 0) {
      return reply.code(400).send({ error: 'user_ids_required' });
    }

    const placeholders = otherIds.map(() => '?').join(',');
    const foundCount = db
      .prepare(`SELECT COUNT(*) AS count FROM users WHERE id IN (${placeholders})`)
      .get(...otherIds).count;
    if (foundCount !== otherIds.length) {
      return reply.code(400).send({ error: 'invalid_user_ids' });
    }

    const isGroup = otherIds.length >= 2;
    if (isGroup && !name) {
      return reply.code(400).send({ error: 'group_name_required' });
    }

    const now = Date.now();

    if (!isGroup) {
      const [otherId] = otherIds;
      const existing = db
        .prepare(
          `SELECT c.id FROM conversations c
           WHERE c.is_group = 0
             AND EXISTS (SELECT 1 FROM participants p WHERE p.conversation_id = c.id AND p.user_id = ?)
             AND EXISTS (SELECT 1 FROM participants p WHERE p.conversation_id = c.id AND p.user_id = ?)
             AND (SELECT COUNT(*) FROM participants p WHERE p.conversation_id = c.id) = 2`,
        )
        .get(request.user.id, otherId);

      if (existing) {
        const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.id);
        return reply.code(200).send({ conversation: serializeConversation(db, conversation, now) });
      }
    }

    const memberIds = [request.user.id, ...otherIds];
    const createTx = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO conversations (is_group, name, created_at) VALUES (?, ?, ?)')
        .run(isGroup ? 1 : 0, isGroup ? name : null, now);
      const conversationId = info.lastInsertRowid;

      const insertParticipant = db.prepare(
        'INSERT INTO participants (conversation_id, user_id, joined_at) VALUES (?, ?, ?)',
      );
      for (const memberId of memberIds) {
        insertParticipant.run(conversationId, memberId, now);
      }

      return conversationId;
    });

    const conversationId = createTx();
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    const serialized = serializeConversation(db, conversation, now);

    // Only the freshly-created path notifies — the dedupe branch above
    // returns an existing conversation, which isn't "new" to anyone.
    await app.notifyNewConversation(serialized, request.user.id);

    return reply.code(201).send({ conversation: serialized });
  });

  app.get('/conversations', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const now = Date.now();

    const rows = db
      .prepare(
        `SELECT c.* FROM conversations c
         JOIN participants p ON p.conversation_id = c.id
         WHERE p.user_id = ?
         ORDER BY c.id DESC`,
      )
      .all(request.user.id);

    return reply.send(rows.map((row) => serializeConversation(db, row, now)));
  });

  app.get('/conversations/:id/messages', { preHandler: requireUser }, async (request, reply) => {
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

    const now = Date.now();
    const messages = db
      .prepare(
        `SELECT id, conversation_id, sender_id, kind, body, media_mode, created_at, expires_at
         FROM messages
         WHERE conversation_id = ? AND expires_at > ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(conversationId, now);

    // Media messages (kind image/video) carry viewable/viewed for the
    // requesting user, computed from the self-destruct rules; text messages
    // are left untouched.
    const reactions = reactionsByMessage(db, messages.map((m) => m.id), request.user.id);
    const withFlags = messages.map((message) => ({
      ...(message.kind === 'text' ? message : { ...message, ...mediaFlags(db, message, request.user.id) }),
      reactions: reactions.get(message.id) ?? [],
    }));

    return reply.send(withFlags);
  });


  // Set (or replace) my reaction on a message; empty emoji clears it.
  app.post('/conversations/:id/messages/:mid/reactions', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const conversationId = Number(request.params.id);
    const messageId = Number(request.params.mid);
    if (!Number.isInteger(conversationId) || !Number.isInteger(messageId)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    if (!isMember(db, conversationId, request.user.id)) {
      return reply.code(403).send({ error: 'not_a_member' });
    }
    const message = db
      .prepare('SELECT id FROM messages WHERE id = ? AND conversation_id = ? AND expires_at > ?')
      .get(messageId, conversationId, Date.now());
    if (!message) {
      return reply.code(404).send({ error: 'message_not_found' });
    }

    let { emoji } = request.body ?? {};
    if (typeof emoji !== 'string' || [...emoji].length > 4) {
      return reply.code(400).send({ error: 'invalid_emoji' });
    }
    emoji = emoji.trim();

    if (!emoji) {
      db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, request.user.id);
    } else {
      db.prepare(
        `INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`,
      ).run(messageId, request.user.id, emoji, Date.now());
    }

    const summary = reactionsByMessage(db, [messageId], request.user.id).get(messageId) ?? [];
    const memberIds = db
      .prepare('SELECT user_id FROM participants WHERE conversation_id = ?')
      .all(conversationId)
      .map((r) => r.user_id);
    // `mine` is per-viewer — send the neutral shape, clients recompute their own flag.
    app.pushToUsers(memberIds, {
      type: 'reaction:update',
      conversation_id: conversationId,
      message_id: messageId,
      user_id: request.user.id,
      emoji,
      reactions: summary.map(({ emoji: e, count, names }) => ({ emoji: e, count, names })),
    });

    return reply.send({ ok: true, reactions: summary });
  });

  app.post('/conversations/:id/messages', { preHandler: requireUser }, async (request, reply) => {
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

    const { body } = request.body ?? {};
    if (typeof body !== 'string' || body.trim().length === 0) {
      return reply.code(400).send({ error: 'body_required' });
    }

    const now = Date.now();
    const expiresAt = now + TEXT_TTL_MS;
    const info = db
      .prepare(
        `INSERT INTO messages (conversation_id, sender_id, kind, body, created_at, expires_at)
         VALUES (?, ?, 'text', ?, ?, ?)`,
      )
      .run(conversationId, request.user.id, body, now, expiresAt);

    const message = db
      .prepare(
        'SELECT id, conversation_id, sender_id, kind, body, created_at, expires_at FROM messages WHERE id = ?',
      )
      .get(info.lastInsertRowid);

    // Fire-and-forget: notifyNewMessage's WS fan-out is synchronous (already
    // done by the time this call returns), but its web-push fan-out is a
    // real network call per recipient (bounded by push.js's own 5s timeout,
    // but that's still 5s the sender shouldn't have to wait on). Not
    // awaited on purpose — the sender's request replies immediately either
    // way; a delivery failure here is logged, never surfaced to the sender.
    app.notifyNewMessage(conversationId, message).catch((err) => {
      request.log.error({ err }, 'notifyNewMessage failed');
    });

    return reply.code(201).send(message);
  });
}
