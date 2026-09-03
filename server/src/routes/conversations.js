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

// Ids of everyone currently in a conversation (WS fan-out lists).
function getMemberIds(db, conversationId) {
  return db
    .prepare('SELECT user_id FROM participants WHERE conversation_id = ?')
    .all(conversationId)
    .map((r) => r.user_id);
}

// The members panel's roster: getParticipants' columns plus when each
// joined, oldest member first.
function getMembers(db, conversationId) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_at, p.joined_at FROM participants p
       JOIN users u ON u.id = p.user_id
       WHERE p.conversation_id = ?
       ORDER BY p.joined_at, u.id`,
    )
    .all(conversationId);
}

// How a user is named in system lines ("X đã thêm Y vào nhóm").
function displayName(user) {
  return user?.display_name || user?.username || 'Ai đó';
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
    // Who opened it — may remove members from a group. null for
    // conversations created before the column existed (see db.js).
    created_by: conversation.created_by ?? null,
    created_at: conversation.created_at,
    participants: getParticipants(db, conversation.id),
    last_message: getLastMessage(db, conversation.id, now),
    // MVP: unread state needs a per-user read-marker table, which is out of
    // scope for this task. Always 0 so the frontend field never breaks;
    // TODO(task-future): compute a real unread count once read-state exists.
    unread_count: 0,
  };
}

// Builds {messageId -> reply snippet} for messages that reference an earlier one.
function replySnippets(db, messages) {
  const ids = [...new Set(messages.map((m) => m.reply_to).filter(Boolean))];
  const out = new Map();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.id, m.kind, m.body, COALESCE(u.display_name, u.username) AS sender_name
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id IN (${placeholders})`,
    )
    .all(...ids);
  for (const r of rows) {
    const snippet = r.kind === 'image' ? '📷 Photo' : r.kind === 'video' ? '🎥 Video' : (r.body ?? '').slice(0, 90);
    out.set(r.id, { id: r.id, sender_name: r.sender_name, snippet });
  }
  return out;
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

// Every column a message row carries in API responses (list, send, edit).
const MESSAGE_COLUMNS = 'id, conversation_id, sender_id, kind, body, media_mode, created_at, expires_at, reply_to, edited_at';

// {senderId -> display name} for every distinct sender in `rows`. Sent as
// `sender_name` so a client can still label a message whose author has
// since left the group — the conversation's participants no longer list
// them, which is otherwise all the client has to go on.
function senderNames(db, rows) {
  const ids = [...new Set(rows.map((m) => m.sender_id))];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const users = db.prepare(`SELECT id, username, display_name FROM users WHERE id IN (${placeholders})`).all(...ids);
  return new Map(users.map((u) => [u.id, displayName(u)]));
}

// Full API shape for message rows from `meId`'s point of view: media
// messages (kind image/video) get viewable/viewed computed from the
// self-destruct rules, text messages are left untouched; everyone gets
// their sender_name, reactions (with `mine` for meId) and the reply snippet.
function serializeMessages(db, rows, meId) {
  const reactions = reactionsByMessage(db, rows.map((m) => m.id), meId);
  const replies = replySnippets(db, rows);
  const names = senderNames(db, rows);
  return rows.map((message) => ({
    ...(message.kind === 'text' ? message : { ...message, ...mediaFlags(db, message, meId) }),
    sender_name: names.get(message.sender_id) ?? null,
    reactions: reactions.get(message.id) ?? [],
    reply: message.reply_to ? replies.get(message.reply_to) ?? null : null,
  }));
}

// Inserts a text message from `sender` ({id, username, display_name}) and
// returns it in the shape POST .../messages replies with (sender_name and
// reply snippet filled in, no reactions yet). Shared by the send route and
// the system lines the members routes post.
function insertTextMessage(db, conversationId, sender, body, replyTo, now) {
  const info = db
    .prepare(
      `INSERT INTO messages (conversation_id, sender_id, kind, body, created_at, expires_at, reply_to)
       VALUES (?, ?, 'text', ?, ?, ?, ?)`,
    )
    .run(conversationId, sender.id, body, now, now + TEXT_TTL_MS, replyTo);

  const message = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(info.lastInsertRowid);
  message.sender_name = displayName(sender);
  message.reply = message.reply_to ? replySnippets(db, [message]).get(message.reply_to) ?? null : null;
  return message;
}

// "@all" and its Vietnamese spellings tag every participant at once. A
// lookahead instead of \b: JS's \b only knows ASCII word characters, so it
// never fires after "cả" and "@tất cả" would silently tag nobody.
const MENTION_ALL_RE = /@(all|tất cả|tat ca|mọi người|moi nguoi)(?![\p{L}\p{N}_])/iu;

// Ids of the participants (other than the sender) whose display name or
// username appears as an @mention in `body`. The client inserts mentions as
// plain "@Tên hiển thị" text, so this is a case-insensitive substring match
// against each member's names — no ids are stored in the message body.
export function mentionedUserIds(db, conversationId, body, senderId) {
  const lower = body.toLowerCase();
  const all = MENTION_ALL_RE.test(body);
  const ids = [];
  for (const p of getParticipants(db, conversationId)) {
    if (p.id === senderId) continue;
    const names = [p.display_name, p.username].filter(Boolean);
    if (all || names.some((n) => lower.includes(`@${n.toLowerCase()}`))) ids.push(p.id);
  }
  return ids;
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
        .prepare('INSERT INTO conversations (is_group, name, created_by, created_at) VALUES (?, ?, ?, ?)')
        .run(isGroup ? 1 : 0, isGroup ? name : null, request.user.id, now);
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
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE conversation_id = ? AND expires_at > ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(conversationId, now);

    return reply.send(serializeMessages(db, messages, request.user.id));
  });

  // Edit the text of one of my own messages. Text-only (media messages have
  // no body to edit), same validation as sending; stamps edited_at so
  // clients can show "(đã sửa)". Deliberately quiet: no web-push and no
  // notifyNewMessage — an edit isn't a new message, and re-notifying every
  // @mention on each typo fix would be noise (mentions aren't stored, they're
  // only ever used to pick push recipients at send time).
  app.patch('/conversations/:id/messages/:mid', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const conversationId = Number(request.params.id);
    const messageId = Number(request.params.mid);
    if (!Number.isInteger(conversationId) || !Number.isInteger(messageId)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    if (!isMember(db, conversationId, request.user.id)) {
      return reply.code(403).send({ error: 'not_a_member' });
    }

    const now = Date.now();
    const message = db
      .prepare('SELECT id, sender_id, kind FROM messages WHERE id = ? AND conversation_id = ? AND expires_at > ?')
      .get(messageId, conversationId, now);
    if (!message) {
      return reply.code(404).send({ error: 'message_not_found' });
    }
    if (message.sender_id !== request.user.id) {
      return reply.code(403).send({ error: 'not_author' });
    }
    if (message.kind !== 'text') {
      return reply.code(400).send({ error: 'not_editable' });
    }

    const { text } = request.body ?? {};
    if (typeof text !== 'string' || text.trim().length === 0) {
      return reply.code(400).send({ error: 'text_required' });
    }

    db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(text.trim(), now, messageId);

    const row = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(messageId);
    const [updated] = serializeMessages(db, [row], request.user.id);

    // Everyone in the conversation — the editor included, so their other
    // open tabs/devices update too. `mine` on reactions is per-viewer, so
    // the event carries the neutral shape (clients keep their own flags),
    // same as reaction:update.
    app.pushToUsers(getMemberIds(db, conversationId), {
      type: 'message:edited',
      conversation_id: conversationId,
      message: {
        ...updated,
        reactions: updated.reactions.map(({ emoji, count, names }) => ({ emoji, count, names })),
      },
    });

    return reply.send(updated);
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
      .prepare('SELECT id, sender_id, kind, body FROM messages WHERE id = ? AND conversation_id = ? AND expires_at > ?')
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
    // `mine` is per-viewer — send the neutral shape, clients recompute their own flag.
    app.pushToUsers(getMemberIds(db, conversationId), {
      type: 'reaction:update',
      conversation_id: conversationId,
      message_id: messageId,
      message_sender_id: message.sender_id,
      user_id: request.user.id,
      emoji,
      reactions: summary.map(({ emoji: e, count, names }) => ({ emoji: e, count, names })),
    });

    // Tell the author someone reacted to their message. Not awaited for the
    // same reason as notifyNewMessage below; clearing a reaction is silent.
    if (emoji && message.sender_id !== request.user.id) {
      const reactor = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(request.user.id);
      const snippet = message.kind === 'image' ? '📷 Ảnh' : message.kind === 'video' ? '🎥 Video' : (message.body ?? '').slice(0, 80);
      app.sendPush([message.sender_id], {
        title: `${emoji} ${reactor?.display_name || reactor?.username || 'Ai đó'} thả cảm xúc`,
        body: snippet,
        url: `/chat/${conversationId}`,
      }).catch((err) => {
        request.log.error({ err }, 'reaction push failed');
      });
    }

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

    const { body, reply_to } = request.body ?? {};
    if (typeof body !== 'string' || body.trim().length === 0) {
      return reply.code(400).send({ error: 'body_required' });
    }
    let replyTo = null;
    let replyAuthorId = null;
    if (reply_to !== undefined && reply_to !== null) {
      replyTo = Number(reply_to);
      const target = Number.isInteger(replyTo)
        ? db.prepare('SELECT id, sender_id FROM messages WHERE id = ? AND conversation_id = ?').get(replyTo, conversationId)
        : null;
      if (!target) {
        return reply.code(400).send({ error: 'invalid_reply_to' });
      }
      replyAuthorId = target.sender_id;
    }

    const message = insertTextMessage(db, conversationId, request.user, body, replyTo, Date.now());

    // Fire-and-forget: notifyNewMessage's WS fan-out is synchronous (already
    // done by the time this call returns), but its web-push fan-out is a
    // real network call per recipient (bounded by push.js's own 5s timeout,
    // but that's still 5s the sender shouldn't have to wait on). Not
    // awaited on purpose — the sender's request replies immediately either
    // way; a delivery failure here is logged, never surfaced to the sender.
    app.notifyNewMessage(conversationId, message, {
      mentionIds: mentionedUserIds(db, conversationId, body, request.user.id),
      replyAuthorId,
    }).catch((err) => {
      request.log.error({ err }, 'notifyNewMessage failed');
    });

    return reply.code(201).send(message);
  });

  // ---- Group membership -------------------------------------------------
  //
  // Only a group (is_group = 1) has a mutable roster; a 1-1 chat's two
  // members are what make it that chat. Every route below is member-only.

  // Shared guard: the conversation must exist (404), the caller must be in
  // it (403 not_a_member — checked before the group test so a stranger
  // learns nothing about a 1-1 chat either), and it must be a group (400
  // not_a_group). Returns the conversation row, or null after having sent
  // the error reply itself.
  function requireGroupMember(request, reply) {
    const db = app.db;
    const conversationId = Number(request.params.id);
    if (!Number.isInteger(conversationId)) {
      reply.code(400).send({ error: 'invalid_conversation_id' });
      return null;
    }
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!conversation) {
      reply.code(404).send({ error: 'conversation_not_found' });
      return null;
    }
    if (!isMember(db, conversationId, request.user.id)) {
      reply.code(403).send({ error: 'not_a_member' });
      return null;
    }
    if (!conversation.is_group) {
      reply.code(400).send({ error: 'not_a_group' });
      return null;
    }
    return conversation;
  }

  // After a roster change: `members:update` (the new roster) to every
  // current member plus `alsoTo` — the user who just left or was removed,
  // whose client drops the chat on seeing itself missing from `members`.
  // Then the system line goes out like any other new message (message:new
  // to the other members, web-push to their phones — for a newcomer that
  // push is how the group first shows up on their phone).
  function announceRoster(request, conversation, action, userId, message, alsoTo = []) {
    const members = getMembers(app.db, conversation.id);
    app.pushToUsers([...members.map((m) => m.id), ...alsoTo], {
      type: 'members:update',
      conversation_id: conversation.id,
      action,
      user_id: userId,
      actor_id: request.user.id,
      members,
    });
    app.notifyNewMessage(conversation.id, message).catch((err) => {
      request.log.error({ err }, 'notifyNewMessage failed');
    });
    return members;
  }

  app.get('/conversations/:id/members', { preHandler: requireUser }, async (request, reply) => {
    const conversation = requireGroupMember(request, reply);
    if (!conversation) return reply;
    return reply.send(getMembers(app.db, conversation.id));
  });

  // Any member may add any existing user. The newcomer also gets the
  // conversation:new the creation path would have sent them — Home lists
  // the group off that exactly as it does a brand-new one.
  app.post('/conversations/:id/members', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const conversation = requireGroupMember(request, reply);
    if (!conversation) return reply;

    const targetId = Number(request.body?.userId);
    if (!Number.isInteger(targetId)) {
      return reply.code(400).send({ error: 'invalid_user_id' });
    }
    const target = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(targetId);
    if (!target) {
      return reply.code(404).send({ error: 'user_not_found' });
    }
    if (isMember(db, conversation.id, targetId)) {
      return reply.code(400).send({ error: 'already_member' });
    }

    const now = Date.now();
    const body = `➕ ${displayName(request.user)} đã thêm ${displayName(target)} vào nhóm`;
    const message = db.transaction(() => {
      db.prepare('INSERT INTO participants (conversation_id, user_id, joined_at) VALUES (?, ?, ?)').run(
        conversation.id,
        targetId,
        now,
      );
      return insertTextMessage(db, conversation.id, request.user, body, null, now);
    })();

    app.pushToUsers([targetId], { type: 'conversation:new', conversation: serializeConversation(db, conversation, now) });
    const members = announceRoster(request, conversation, 'add', targetId, message);

    return reply.code(201).send({ ok: true, members, message });
  });

  // Removing yourself is leaving (anyone may; the last one out leaves an
  // empty conversation behind that nobody lists and whose messages expire
  // on their own). Removing someone else takes the group's creator or an
  // app admin.
  app.delete('/conversations/:id/members/:userId', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const conversation = requireGroupMember(request, reply);
    if (!conversation) return reply;

    const targetId = Number(request.params.userId);
    if (!Number.isInteger(targetId)) {
      return reply.code(400).send({ error: 'invalid_user_id' });
    }
    const leaving = targetId === request.user.id;
    if (!leaving && !request.user.is_admin && conversation.created_by !== request.user.id) {
      return reply.code(403).send({ error: 'not_allowed' });
    }
    const target = leaving
      ? request.user
      : db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(targetId);
    if (!target || !isMember(db, conversation.id, targetId)) {
      return reply.code(404).send({ error: 'member_not_found' });
    }

    const now = Date.now();
    const body = leaving
      ? `🚪 ${displayName(request.user)} đã rời nhóm`
      : `➖ ${displayName(request.user)} đã xoá ${displayName(target)} khỏi nhóm`;
    const message = db.transaction(() => {
      db.prepare('DELETE FROM participants WHERE conversation_id = ? AND user_id = ?').run(conversation.id, targetId);
      return insertTextMessage(db, conversation.id, request.user, body, null, now);
    })();

    const members = announceRoster(request, conversation, leaving ? 'leave' : 'remove', targetId, message, [targetId]);

    return reply.send({ ok: true, members, message });
  });
}
