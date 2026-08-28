import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeTestDb } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Pulls the `lb_session=...` cookie (name=value only, no attributes) out of a
// fastify.inject() response so it can be replayed on the next request.
function extractSessionCookie(response) {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((c) => c.startsWith('lb_session='));
  return sessionCookie ? sessionCookie.split(';')[0] : null;
}

function buildTestApp() {
  const { db, mediaDir } = makeTestDb();
  const config = loadConfig({ SESSION_SECRET: 'test-secret' });
  return buildApp({ config, db, mediaDir });
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
  const aliceRes = await registerUser(app, { username: 'alice', password: 'password123' });
  const alice = { id: aliceRes.json().user.id, cookie: extractSessionCookie(aliceRes) };

  const others = [];
  for (let i = 0; i < n; i++) {
    const code = await createInvite(app, alice.cookie);
    const res = await registerUser(app, { username: names[i], password: 'password123', invite: code });
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
