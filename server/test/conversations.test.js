import { describe, it, expect, vi, afterEach } from 'vitest';
import webpush from 'web-push';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeTestDb } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

// Pulls the `lb_session=...` cookie (name=value only, no attributes) out of a
// fastify.inject() response so it can be replayed on the next request.
function extractSessionCookie(response) {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((c) => c.startsWith('lb_session='));
  return sessionCookie ? sessionCookie.split(';')[0] : null;
}

function buildTestApp(envOverrides = {}) {
  const { db, mediaDir } = makeTestDb();
  const config = loadConfig({ SESSION_SECRET: 'test-secret', ...envOverrides });
  return buildApp({ config, db, mediaDir, logger: false });
}

function registerUser(app, body) {
  return app.inject({ method: 'POST', url: '/api/auth/register', payload: body });
}

async function createInvite(app, adminCookie) {
  const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { cookie: adminCookie } });
  return res.json().code;
}

// Registers alice as the admin (first user, no invite needed) plus `n` more
// users (bob, carol, dave, ...), each joining via a freshly minted invite
// code. Returns { alice: {id, cookie}, others: [{id, cookie}, ...] }.
async function setupUsers(app, n) {
  const names = ['bob', 'carol', 'dave', 'erin'];
  const aliceRes = await registerUser(app, { username: 'alice', password: 'password1234' });
  const alice = { id: aliceRes.json().user.id, cookie: extractSessionCookie(aliceRes) };

  const others = [];
  for (let i = 0; i < n; i++) {
    const code = await createInvite(app, alice.cookie);
    const res = await registerUser(app, { username: names[i], password: 'password1234', invite: code });
    others.push({ id: res.json().user.id, cookie: extractSessionCookie(res) });
  }

  return { alice, others };
}

function createConversation(app, cookie, payload) {
  return app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie }, payload });
}

function listConversations(app, cookie) {
  return app.inject({ method: 'GET', url: '/api/conversations', headers: { cookie } });
}

function getMessages(app, cookie, conversationId) {
  return app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages`, headers: { cookie } });
}

function sendText(app, cookie, conversationId, body) {
  return app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/messages`,
    headers: { cookie },
    payload: { body },
  });
}

function editText(app, cookie, conversationId, messageId, text) {
  return app.inject({
    method: 'PATCH',
    url: `/api/conversations/${conversationId}/messages/${messageId}`,
    headers: { cookie },
    payload: { text },
  });
}

describe('POST /api/conversations', () => {
  it('creates a 1-1 conversation from a single user_id with no name', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;

    const res = await createConversation(app, alice.cookie, { user_ids: [bob.id] });

    expect(res.statusCode).toBe(201);
    const { conversation } = res.json();
    expect(conversation.is_group).toBe(false);
    expect(conversation.name).toBeNull();
    const ids = conversation.participants.map((p) => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([alice.id, bob.id].sort((a, b) => a - b));
  });

  it('dedupes a 1-1 conversation for the same pair of users', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;

    const first = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const second = await createConversation(app, alice.cookie, { user_ids: [bob.id] });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().conversation.id).toBe(first.json().conversation.id);

    const count = app.db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count;
    expect(count).toBe(1);
  });

  it('creates a group conversation with >=2 user_ids and a name', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;

    const res = await createConversation(app, alice.cookie, {
      user_ids: [bob.id, carol.id],
      name: 'Family',
    });

    expect(res.statusCode).toBe(201);
    const { conversation } = res.json();
    expect(conversation.is_group).toBe(true);
    expect(conversation.name).toBe('Family');
    expect(conversation.participants).toHaveLength(3);
  });

  it('rejects a group conversation without a name with 400', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;

    const res = await createConversation(app, alice.cookie, { user_ids: [bob.id, carol.id] });

    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without a session cookie', async () => {
    const app = buildTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/conversations', payload: { user_ids: [1] } });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/conversations', () => {
  it('lists conversations with participants and the latest non-expired message', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;
    await sendText(app, alice.cookie, conversationId, 'hi bob');

    const res = await listConversations(app, bob.cookie);

    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(conversationId);
    expect(list[0].unread_count).toBe(0);
    expect(list[0].last_message.body).toBe('hi bob');
    expect(list[0].last_message.kind).toBe('text');
  });

  it('omits an expired message from last_message but keeps the conversation listed', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;
    const sent = await sendText(app, alice.cookie, conversationId, 'stale');
    const messageId = sent.json().id;

    app.db.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, messageId);

    const res = await listConversations(app, alice.cookie);

    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0].last_message).toBeNull();
  });

  it('returns 401 without a session cookie', async () => {
    const app = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/conversations' });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/conversations/:id/messages', () => {
  it('returns messages oldest first with body and expiry', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;
    await sendText(app, alice.cookie, conversationId, 'first');
    await sendText(app, bob.cookie, conversationId, 'second');

    const res = await getMessages(app, alice.cookie, conversationId);

    expect(res.statusCode).toBe(200);
    const messages = res.json();
    expect(messages).toHaveLength(2);
    expect(messages[0].body).toBe('first');
    expect(messages[1].body).toBe('second');
    expect(messages[0].kind).toBe('text');
    expect(messages[0].expires_at - messages[0].created_at).toBe(DAY_MS);
  });

  it('excludes expired messages', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;
    const sent = await sendText(app, alice.cookie, conversationId, 'stale');
    app.db.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, sent.json().id);

    const res = await getMessages(app, alice.cookie, conversationId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });

  it('returns 403 for a non-member', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;

    const res = await getMessages(app, carol.cookie, conversationId);

    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/conversations/:id/messages', () => {
  it('creates a text message that expires 24h from now', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;

    const before = Date.now();
    const res = await sendText(app, alice.cookie, conversationId, 'hello');
    const after = Date.now();

    expect(res.statusCode).toBe(201);
    const message = res.json();
    expect(message.body).toBe('hello');
    expect(message.kind).toBe('text');
    expect(message.sender_id).toBe(alice.id);
    expect(message.expires_at - message.created_at).toBe(DAY_MS);
    expect(message.created_at).toBeGreaterThanOrEqual(before);
    expect(message.created_at).toBeLessThanOrEqual(after);
  });

  it('hands @mentioned participants and the replied-to author to notifyNewMessage', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id, carol.id], name: 'Nhà' });
    const conversationId = created.json().conversation.id;

    const calls = [];
    app.notifyNewMessage = async (convId, message, opts) => {
      calls.push({ convId, message, opts });
    };

    // Case-insensitive username match; a stranger's "@name" tags nobody.
    await sendText(app, alice.cookie, conversationId, 'ê @Bob xem cái này, @zed');
    expect(calls[0].opts.mentionIds).toEqual([bob.id]);
    expect(calls[0].opts.replyAuthorId).toBeNull();

    // @all (and its Vietnamese spellings) tags everyone but the sender.
    await sendText(app, bob.cookie, conversationId, '@tất cả ăn cơm chưa');
    expect(calls[1].opts.mentionIds.sort()).toEqual([alice.id, carol.id].sort());

    // Replying passes the original author along.
    const replyRes = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: carol.cookie },
      payload: { body: 'rồi', reply_to: calls[1].message.id },
    });
    expect(replyRes.statusCode).toBe(201);
    expect(calls[2].opts.replyAuthorId).toBe(bob.id);
    expect(calls[2].opts.mentionIds).toEqual([]);
  });

  it('calls the notifyNewMessage hook after inserting the message', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;

    const calls = [];
    app.notifyNewMessage = async (convId, message) => {
      calls.push({ convId, message });
    };

    await sendText(app, alice.cookie, conversationId, 'hi');

    expect(calls).toHaveLength(1);
    expect(calls[0].convId).toBe(conversationId);
    expect(calls[0].message.body).toBe('hi');
  });

  // I5: notifyNewMessage's web-push fan-out is a real network call per
  // recipient (routes/conversations.js calls it without awaiting it). The
  // sender's reply must come back immediately even while that fan-out is
  // still in flight against a slow (or hung) push endpoint.
  it('replies to the sender without waiting for a slow web-push send to the recipient to finish', async () => {
    const vapidKeys = webpush.generateVAPIDKeys();
    const app = buildTestApp({
      VAPID_PUBLIC_KEY: vapidKeys.publicKey,
      VAPID_PRIVATE_KEY: vapidKeys.privateKey,
      VAPID_SUBJECT: 'mailto:test@example.com',
    });
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;

    // Bob has no open WS socket in this test (fastify.inject doesn't open
    // one), so sendPush will actually try to push to this subscription.
    await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie: bob.cookie },
      payload: { subscription: { endpoint: 'https://push.example/bob', keys: { p256dh: 'p-key', auth: 'a-key' } } },
    });

    let resolveSend;
    const sendGate = new Promise((resolve) => {
      resolveSend = resolve;
    });
    const sendSpy = vi.spyOn(webpush, 'sendNotification').mockImplementation(() => sendGate);

    const start = Date.now();
    const res = await sendText(app, alice.cookie, conv.id, 'hi bob');
    const elapsed = Date.now() - start;

    expect(res.statusCode).toBe(201);
    // The push send is still pending (sendGate hasn't resolved) — the reply
    // above only came back this fast because it didn't wait on it.
    expect(elapsed).toBeLessThan(500);
    expect(sendSpy).toHaveBeenCalled();

    resolveSend({}); // let the background push settle before the test ends
    await sleep(0);
  });

  it('returns 403 for a non-member', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;

    const res = await sendText(app, carol.cookie, conversationId, 'sneaky');

    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for an empty body', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;

    const res = await sendText(app, alice.cookie, conversationId, '   ');

    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without a session cookie', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { body: 'hi' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/conversations/:id/messages/:mid/reactions push', () => {
  async function setupWithMessage() {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;
    const message = (await sendText(app, alice.cookie, conversationId, 'chào')).json();
    const pushes = [];
    app.sendPush = async (userIds, payload) => {
      pushes.push({ userIds, payload });
    };
    const react = (cookie, emoji) =>
      app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/messages/${message.id}/reactions`,
        headers: { cookie },
        payload: { emoji },
      });
    return { app, alice, bob, conversationId, message, pushes, react };
  }

  it('pushes the message author when someone else reacts, quoting the message', async () => {
    const { alice, bob, conversationId, pushes, react } = await setupWithMessage();
    const res = await react(bob.cookie, '❤️');
    expect(res.statusCode).toBe(200);
    await sleep(0); // the push is fired without awaiting
    expect(pushes).toHaveLength(1);
    expect(pushes[0].userIds).toEqual([alice.id]);
    expect(pushes[0].payload.title).toContain('❤️');
    expect(pushes[0].payload.title).toContain('bob');
    expect(pushes[0].payload.body).toBe('chào');
    expect(pushes[0].payload.url).toBe(`/chat/${conversationId}`);
  });

  it('stays silent for self-reactions and for clearing a reaction', async () => {
    const { alice, bob, pushes, react } = await setupWithMessage();
    await react(alice.cookie, '👍');
    await react(bob.cookie, '❤️');
    await react(bob.cookie, '');
    await sleep(0);
    expect(pushes).toHaveLength(1);
  });

  it('includes the message author in the reaction:update WS event', async () => {
    const { app, alice, bob, message, react } = await setupWithMessage();
    const events = [];
    app.pushToUsers = (userIds, event) => {
      events.push({ userIds, event });
    };
    await react(bob.cookie, '🔥');
    const update = events.find((e) => e.event.type === 'reaction:update');
    expect(update.event.message_id).toBe(message.id);
    expect(update.event.message_sender_id).toBe(alice.id);
    expect(update.event.user_id).toBe(bob.id);
  });
});

describe('PATCH /api/conversations/:id/messages/:mid', () => {
  // alice + bob share a 1-1 conversation with one text message from alice;
  // carol exists but is not a member. WS/push/notify are stubbed AFTER the
  // initial send so they only ever record what the edit itself does.
  async function setupWithMessage() {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;
    const created = await createConversation(app, alice.cookie, { user_ids: [bob.id] });
    const conversationId = created.json().conversation.id;
    const message = (await sendText(app, alice.cookie, conversationId, 'chào')).json();
    const events = [];
    app.pushToUsers = (userIds, event) => {
      events.push({ userIds, event });
    };
    const pushes = [];
    app.sendPush = async (userIds, payload) => {
      pushes.push({ userIds, payload });
    };
    const notifies = [];
    app.notifyNewMessage = async (...args) => {
      notifies.push(args);
    };
    return { app, alice, bob, carol, conversationId, message, events, pushes, notifies };
  }

  it('lets the author edit: trimmed body, edited_at stamped, message:edited to every member, no push', async () => {
    const { app, alice, bob, conversationId, message, events, pushes, notifies } = await setupWithMessage();
    expect(message.edited_at).toBeNull();

    const before = Date.now();
    const res = await editText(app, alice.cookie, conversationId, message.id, '  chào lại  ');

    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.id).toBe(message.id);
    expect(updated.body).toBe('chào lại');
    expect(updated.sender_id).toBe(alice.id);
    expect(updated.kind).toBe('text');
    expect(updated.created_at).toBe(message.created_at);
    expect(updated.expires_at).toBe(message.expires_at);
    expect(updated.edited_at).toBeGreaterThanOrEqual(before);
    expect(updated.reactions).toEqual([]);
    expect(updated.reply).toBeNull();

    // The list endpoint shows the same edited shape to the other member.
    const listed = (await getMessages(app, bob.cookie, conversationId)).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].body).toBe('chào lại');
    expect(listed[0].edited_at).toBe(updated.edited_at);

    const edited = events.filter((e) => e.event.type === 'message:edited');
    expect(edited).toHaveLength(1);
    expect([...edited[0].userIds].sort()).toEqual([alice.id, bob.id].sort());
    expect(edited[0].event.conversation_id).toBe(conversationId);
    expect(edited[0].event.message.id).toBe(message.id);
    expect(edited[0].event.message.body).toBe('chào lại');
    expect(edited[0].event.message.edited_at).toBe(updated.edited_at);

    await sleep(0);
    expect(pushes).toHaveLength(0);
    expect(notifies).toHaveLength(0);
  });

  it('returns 403 when someone other than the author edits, leaving the message untouched', async () => {
    const { app, alice, bob, conversationId, message, events } = await setupWithMessage();

    const res = await editText(app, bob.cookie, conversationId, message.id, 'hack');

    expect(res.statusCode).toBe(403);
    const listed = (await getMessages(app, alice.cookie, conversationId)).json();
    expect(listed[0].body).toBe('chào');
    expect(listed[0].edited_at).toBeNull();
    expect(events.some((e) => e.event.type === 'message:edited')).toBe(false);
  });

  it('returns 403 for a non-member', async () => {
    const { app, carol, conversationId, message } = await setupWithMessage();

    const res = await editText(app, carol.cookie, conversationId, message.id, 'sneaky');

    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for empty or missing text', async () => {
    const { app, alice, conversationId, message } = await setupWithMessage();

    expect((await editText(app, alice.cookie, conversationId, message.id, '   ')).statusCode).toBe(400);
    expect((await editText(app, alice.cookie, conversationId, message.id, undefined)).statusCode).toBe(400);

    const listed = (await getMessages(app, alice.cookie, conversationId)).json();
    expect(listed[0].body).toBe('chào');
    expect(listed[0].edited_at).toBeNull();
  });

  it('returns 400 for a media message', async () => {
    const { app, alice, conversationId } = await setupWithMessage();
    const now = Date.now();
    const info = app.db
      .prepare(
        `INSERT INTO messages (conversation_id, sender_id, kind, media_path, media_mode, created_at, expires_at)
         VALUES (?, ?, 'image', '/nonexistent/photo.png', '24h', ?, ?)`,
      )
      .run(conversationId, alice.id, now, now + DAY_MS);

    const res = await editText(app, alice.cookie, conversationId, Number(info.lastInsertRowid), 'caption');

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not_editable');
  });
});
