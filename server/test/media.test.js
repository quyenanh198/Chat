import { existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeTestDb } from './helpers.js';

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

function getMessages(app, cookie, conversationId) {
  return app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages`, headers: { cookie } });
}

function patchSettings(app, cookie, media_mode) {
  return app.inject({ method: 'PATCH', url: '/api/me/settings', headers: { cookie }, payload: { media_mode } });
}

function getMedia(app, cookie, messageId) {
  return app.inject({ method: 'GET', url: `/api/media/${messageId}`, headers: { cookie } });
}

// Builds a real multipart/form-data body (via undici's global FormData +
// Request, which encodes it with a proper boundary) and feeds the resulting
// buffer + headers into fastify's inject() — this is what a real multipart
// upload looks like on the wire, unlike hand-rolling a boundary string.
async function uploadMedia(app, cookie, conversationId, { filename = 'test.png', mimetype = 'image/png', buffer }) {
  const form = new FormData();
  form.set('file', new Blob([buffer], { type: mimetype }), filename);
  const request = new Request('http://localhost/upload', { method: 'POST', body: form });
  const payload = Buffer.from(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  headers.cookie = cookie;

  return app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/media`,
    headers,
    payload,
  });
}

const FAKE_PNG = Buffer.alloc(1024, 0xab); // 1KB fake PNG body — content is never sniffed, only mimetype matters

describe('POST /api/conversations/:id/media', () => {
  it('creates an image message with media_mode = sender current setting', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;

    const res = await uploadMedia(app, alice.cookie, conv.id, { buffer: FAKE_PNG });

    expect(res.statusCode).toBe(201);
    const message = res.json();
    expect(message.kind).toBe('image');
    expect(message.sender_id).toBe(alice.id);
    expect(message.media_mode).toBe('once');
    expect(message.expires_at - message.created_at).toBe(24 * 60 * 60 * 1000);
  });

  it('tags a video/* upload as kind video', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;

    const res = await uploadMedia(app, alice.cookie, conv.id, {
      filename: 'clip.mp4',
      mimetype: 'video/mp4',
      buffer: FAKE_PNG,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('video');
  });

  it('rejects an unsupported mimetype with 415', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;

    const res = await uploadMedia(app, alice.cookie, conv.id, {
      filename: 'notes.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('hello'),
    });

    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('unsupported_media_type');
  });

  it('rejects an upload over config.maxUploadBytes with fastify 413', async () => {
    const app = buildTestApp({ MAX_UPLOAD_MB: '0.001' }); // ~1048 bytes cap
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;

    const res = await uploadMedia(app, alice.cookie, conv.id, { buffer: Buffer.alloc(10_000, 1) });

    expect(res.statusCode).toBe(413);
  });

  it('returns 403 for a non-member', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;

    const res = await uploadMedia(app, carol.cookie, conv.id, { buffer: FAKE_PNG });

    expect(res.statusCode).toBe(403);
  });

  it('calls the notifyNewMessage hook after inserting the media message', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;

    const calls = [];
    app.notifyNewMessage = async (convId, message) => calls.push({ convId, message });

    await uploadMedia(app, alice.cookie, conv.id, { buffer: FAKE_PNG });

    expect(calls).toHaveLength(1);
    expect(calls[0].message.kind).toBe('image');
  });
});

describe('GET /api/media/:messageId — mode once', () => {
  it('lets each recipient view exactly once, deletes the message + file once everyone (but the sender) has viewed', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 2); // alice default media_mode = 'once'
    const [bob, carol] = others;
    const conv = (
      await createConversation(app, alice.cookie, { user_ids: [bob.id, carol.id], name: 'Fam' })
    ).json().conversation;

    const uploadRes = await uploadMedia(app, alice.cookie, conv.id, { buffer: FAKE_PNG });
    const messageId = uploadRes.json().id;
    const mediaPath = app.db.prepare('SELECT media_path FROM messages WHERE id = ?').get(messageId).media_path;
    expect(existsSync(mediaPath)).toBe(true);

    // Sender can view her own media any number of times, with no view recorded.
    const senderView1 = await getMedia(app, alice.cookie, messageId);
    const senderView2 = await getMedia(app, alice.cookie, messageId);
    expect(senderView1.statusCode).toBe(200);
    expect(senderView2.statusCode).toBe(200);
    expect(senderView1.rawPayload.equals(FAKE_PNG)).toBe(true);
    const senderViewRow = app.db
      .prepare('SELECT 1 AS x FROM media_views WHERE message_id = ? AND user_id = ?')
      .get(messageId, alice.id);
    expect(senderViewRow).toBeUndefined();

    // Bob's first view succeeds and streams the exact bytes back.
    const bobFirst = await getMedia(app, bob.cookie, messageId);
    expect(bobFirst.statusCode).toBe(200);
    expect(bobFirst.headers['content-type']).toBe('image/png');
    expect(bobFirst.rawPayload.equals(FAKE_PNG)).toBe(true);

    // Bob's second view is rejected — already used his one view.
    const bobSecond = await getMedia(app, bob.cookie, messageId);
    expect(bobSecond.statusCode).toBe(403);
    expect(bobSecond.json().error).toBe('already_viewed');

    // Message still exists (carol hasn't viewed yet); flags reflect state correctly.
    const afterBob = (await getMessages(app, alice.cookie, conv.id)).json();
    const mediaMsg = afterBob.find((m) => m.id === messageId);
    expect(mediaMsg).toBeTruthy();

    const bobList = (await getMessages(app, bob.cookie, conv.id)).json().find((m) => m.id === messageId);
    expect(bobList.viewed).toBe(true);
    expect(bobList.viewable).toBe(false);

    const carolListBefore = (await getMessages(app, carol.cookie, conv.id)).json().find((m) => m.id === messageId);
    expect(carolListBefore.viewed).toBe(false);
    expect(carolListBefore.viewable).toBe(true);

    // Carol views — now every recipient (bob, carol) has viewed: file + message vanish.
    const carolView = await getMedia(app, carol.cookie, messageId);
    expect(carolView.statusCode).toBe(200);
    expect(carolView.rawPayload.equals(FAKE_PNG)).toBe(true);

    expect(existsSync(mediaPath)).toBe(false);
    const row = app.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    expect(row).toBeUndefined();
    const viewsLeft = app.db.prepare('SELECT COUNT(*) AS c FROM media_views WHERE message_id = ?').get(messageId).c;
    expect(viewsLeft).toBe(0);

    const listAfter = (await getMessages(app, alice.cookie, conv.id)).json();
    expect(listAfter.find((m) => m.id === messageId)).toBeUndefined();
  });

  it('deletes immediately in a 1-1 conversation once the single recipient has viewed', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;
    const uploadRes = await uploadMedia(app, alice.cookie, conv.id, { buffer: FAKE_PNG });
    const messageId = uploadRes.json().id;
    const mediaPath = app.db.prepare('SELECT media_path FROM messages WHERE id = ?').get(messageId).media_path;

    const res = await getMedia(app, bob.cookie, messageId);

    expect(res.statusCode).toBe(200);
    expect(existsSync(mediaPath)).toBe(false);
    expect(app.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)).toBeUndefined();
  });

  it('returns 403 for a non-member trying to view', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;
    const uploadRes = await uploadMedia(app, alice.cookie, conv.id, { buffer: FAKE_PNG });

    const res = await getMedia(app, carol.cookie, uploadRes.json().id);

    expect(res.statusCode).toBe(403);
  });

  it('returns 404 once the message has expired', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;
    const uploadRes = await uploadMedia(app, alice.cookie, conv.id, { buffer: FAKE_PNG });
    const messageId = uploadRes.json().id;
    app.db.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, messageId);

    const res = await getMedia(app, bob.cookie, messageId);

    expect(res.statusCode).toBe(404);
  });

  it('regression: keeps enforcing the media_mode recorded at send time even after the sender later switches their setting', async () => {
    const app = buildTestApp();
    // A group of 2 recipients so bob's view alone doesn't trigger the
    // "everyone viewed" deletion — otherwise his 2nd request would 404
    // (message gone) rather than exercise the already_viewed 403 path.
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;
    const conv = (
      await createConversation(app, alice.cookie, { user_ids: [bob.id, carol.id], name: 'Fam' })
    ).json().conversation;

    // alice is still on the default 'once' setting when she sends this one.
    const uploadRes = await uploadMedia(app, alice.cookie, conv.id, { buffer: FAKE_PNG });
    const messageId = uploadRes.json().id;
    expect(uploadRes.json().media_mode).toBe('once');

    // She flips her setting to '24h' AFTER sending — the already-sent
    // message must keep enforcing the mode it was sent with, not her
    // current setting.
    const settingsRes = await patchSettings(app, alice.cookie, '24h');
    expect(settingsRes.statusCode).toBe(200);

    const first = await getMedia(app, bob.cookie, messageId);
    expect(first.statusCode).toBe(200);

    const second = await getMedia(app, bob.cookie, messageId);
    expect(second.statusCode).toBe(403);
    expect(second.json().error).toBe('already_viewed');
  });

  it('regression: concurrent double-view from the same once-mode recipient succeeds exactly once (no TOCTOU)', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;
    const uploadRes = await uploadMedia(app, alice.cookie, conv.id, { buffer: FAKE_PNG });
    const messageId = uploadRes.json().id;

    // Two requests from bob "at once": the view-once gate must be an atomic
    // INSERT-and-check, not a separate SELECT-then-INSERT straddling the
    // `await readFile` — otherwise both could pass the check before either
    // records a view and bob gets the file twice.
    const [first, second] = await Promise.all([
      getMedia(app, bob.cookie, messageId),
      getMedia(app, bob.cookie, messageId),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 403]);
    const winner = first.statusCode === 200 ? first : second;
    expect(winner.rawPayload.equals(FAKE_PNG)).toBe(true);

    // bob was the only recipient, so his one legitimate view already
    // deleted the message + its media_views rows.
    expect(app.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)).toBeUndefined();
    const viewsLeft = app.db.prepare('SELECT COUNT(*) AS c FROM media_views WHERE message_id = ?').get(messageId).c;
    expect(viewsLeft).toBe(0);
  });
});

describe('GET /api/media/:messageId — mode 24h', () => {
  it('lets a recipient view freely (multiple times) and marks viewed without ever 403-ing', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const conv = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;

    const settingsRes = await patchSettings(app, alice.cookie, '24h');
    expect(settingsRes.statusCode).toBe(200);

    const uploadRes = await uploadMedia(app, alice.cookie, conv.id, { buffer: FAKE_PNG });
    expect(uploadRes.json().media_mode).toBe('24h');
    const messageId = uploadRes.json().id;

    for (let i = 0; i < 3; i++) {
      const res = await getMedia(app, bob.cookie, messageId);
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(FAKE_PNG)).toBe(true);
    }

    // Still present in the list — 24h mode doesn't delete on view.
    const bobList = (await getMessages(app, bob.cookie, conv.id)).json().find((m) => m.id === messageId);
    expect(bobList.viewed).toBe(true);
    expect(bobList.viewable).toBe(true);

    const row = app.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    expect(row).toBeTruthy();
  });
});
