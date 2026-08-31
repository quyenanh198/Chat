import { describe, it, expect, vi, afterEach } from 'vitest';
import webpush from 'web-push';
import { createPush } from '../src/push.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeTestDb } from './helpers.js';

// Real, validly-shaped VAPID keys (generated once, no network call) — used
// whenever a test needs createPush to accept `config.vapid` as configured.
// web-push's setVapidDetails validates key byte-length, so a fake/short
// string would throw before sendPush is even reached.
const VAPID_KEYS = webpush.generateVAPIDKeys();

function vapidConfig(overrides = {}) {
  return loadConfig({
    SESSION_SECRET: 'test-secret',
    VAPID_PUBLIC_KEY: VAPID_KEYS.publicKey,
    VAPID_PRIVATE_KEY: VAPID_KEYS.privateKey,
    VAPID_SUBJECT: 'mailto:test@example.com',
    ...overrides,
  });
}

function insertSub(db, { userId, endpoint = `https://push.example/${userId}` }) {
  db.prepare(
    `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'p256dh-key', 'auth-key', ?)`,
  ).run(userId, endpoint, Date.now());
  return endpoint;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPush', () => {
  it('sendPush is a safe no-op when vapid is not configured: never throws, never touches the db', async () => {
    const { db } = makeTestDb();
    const config = loadConfig({ SESSION_SECRET: 'test-secret' }); // no VAPID_* -> config.vapid === null
    const logger = { warn: vi.fn() };
    const querySpy = vi.spyOn(db, 'prepare');

    const { sendPush } = createPush(config, db, () => false, logger);

    // Logged exactly once, at construction — not per sendPush call.
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await expect(sendPush([1, 2], { title: 'x', body: 'y', url: '/chat/1' })).resolves.toBeUndefined();
    await expect(sendPush(1, { title: 'x', body: 'y', url: '/chat/1' })).resolves.toBeUndefined();
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('does not log when vapid is configured', () => {
    const { db } = makeTestDb();
    const logger = { warn: vi.fn() };

    createPush(vapidConfig(), db, () => false, logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('sends to every subscription even when the userId has an open websocket (multi-device delivery)', async () => {
    const { db } = makeTestDb();
    const sendSpy = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({});
    const first = insertSub(db, { userId: 1 });
    const second = insertSub(db, { userId: 2 });

    const hasOpenSocket = (id) => id === 1;
    const { sendPush } = createPush(vapidConfig(), db, hasOpenSocket, { warn: vi.fn() });

    await sendPush([1, 2], { title: 't', body: 'b', url: '/x' });

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls.map((c) => c[0].endpoint).sort()).toEqual([first, second].sort());
  });

  it('deletes the push_subs row when the push service responds 410 Gone', async () => {
    const { db } = makeTestDb();
    const endpoint = insertSub(db, { userId: 1 });
    vi.spyOn(webpush, 'sendNotification').mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));

    const { sendPush } = createPush(vapidConfig(), db, () => false, { warn: vi.fn() });
    await sendPush([1], { title: 't', body: 'b', url: '/x' });

    expect(db.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').get(endpoint)).toBeUndefined();
  });

  it('deletes the push_subs row when the push service responds 404 Not Found', async () => {
    const { db } = makeTestDb();
    const endpoint = insertSub(db, { userId: 1 });
    vi.spyOn(webpush, 'sendNotification').mockRejectedValue(Object.assign(new Error('missing'), { statusCode: 404 }));

    const { sendPush } = createPush(vapidConfig(), db, () => false, { warn: vi.fn() });
    await sendPush([1], { title: 't', body: 'b', url: '/x' });

    expect(db.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').get(endpoint)).toBeUndefined();
  });

  it('keeps the push_subs row and does not throw on a transient (non-410/404) failure', async () => {
    const { db } = makeTestDb();
    const endpoint = insertSub(db, { userId: 1 });
    vi.spyOn(webpush, 'sendNotification').mockRejectedValue(Object.assign(new Error('server error'), { statusCode: 500 }));

    const { sendPush } = createPush(vapidConfig(), db, () => false, { warn: vi.fn() });

    await expect(sendPush([1], { title: 't', body: 'b', url: '/x' })).resolves.toBeUndefined();
    expect(db.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').get(endpoint)).toBeTruthy();
  });

  it('is a no-op with no matching push_subs rows (no crash, sendNotification never called)', async () => {
    const { db } = makeTestDb();
    const sendSpy = vi.spyOn(webpush, 'sendNotification');

    const { sendPush } = createPush(vapidConfig(), db, () => false, { warn: vi.fn() });
    await expect(sendPush([42], { title: 't', body: 'b', url: '/x' })).resolves.toBeUndefined();

    expect(sendSpy).not.toHaveBeenCalled();
  });

  // I5: a subscription whose endpoint accepts the connection and simply
  // never responds must not hang sendPush (and therefore whatever caller —
  // notifyNewMessage's request handler — is waiting on it) forever. The 5th
  // constructor arg overrides the default 5s timeout down to a few ms so
  // this doesn't have to actually wait 5 seconds.
  it('does not hang forever when sendNotification never resolves: races against its timeout', async () => {
    const { db } = makeTestDb();
    const endpoint = insertSub(db, { userId: 1 });
    vi.spyOn(webpush, 'sendNotification').mockImplementation(() => new Promise(() => {})); // never settles

    const { sendPush } = createPush(vapidConfig(), db, () => false, { warn: vi.fn() }, 20);

    await expect(sendPush([1], { title: 't', body: 'b', url: '/x' })).resolves.toBeUndefined();
    // A timeout isn't proof the endpoint is dead (unlike 404/410) — the row
    // is kept, same as any other transient failure.
    expect(db.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').get(endpoint)).toBeTruthy();
  });

  it('lets one subscription time out without blocking delivery to a faster one', async () => {
    const { db } = makeTestDb();
    insertSub(db, { userId: 1, endpoint: 'https://push.example/slow' });
    insertSub(db, { userId: 1, endpoint: 'https://push.example/fast' });
    vi.spyOn(webpush, 'sendNotification').mockImplementation((sub) => {
      if (sub.endpoint.endsWith('/slow')) return new Promise(() => {}); // never settles
      return Promise.resolve({});
    });

    const { sendPush } = createPush(vapidConfig(), db, () => false, { warn: vi.fn() }, 20);

    await expect(sendPush([1], { title: 't', body: 'b', url: '/x' })).resolves.toBeUndefined();
  });
});

function buildTestApp(envOverrides = {}) {
  const { db, mediaDir } = makeTestDb();
  const config = loadConfig({ SESSION_SECRET: 'test-secret', ...envOverrides });
  return buildApp({ config, db, mediaDir, logger: false });
}

function extractSessionCookie(response) {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((c) => c.startsWith('lb_session='));
  return sessionCookie ? sessionCookie.split(';')[0] : null;
}

async function registerAndLogin(app) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', password: 'password1234' },
  });
  return { id: res.json().user.id, cookie: extractSessionCookie(res) };
}

describe('GET /api/push/vapid', () => {
  it('returns 404 push_disabled when vapid is not configured', async () => {
    const app = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/push/vapid' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('push_disabled');
  });

  it('returns the public key with no auth required when vapid is configured', async () => {
    const app = buildTestApp({
      VAPID_PUBLIC_KEY: VAPID_KEYS.publicKey,
      VAPID_PRIVATE_KEY: VAPID_KEYS.privateKey,
      VAPID_SUBJECT: 'mailto:test@example.com',
    });

    const res = await app.inject({ method: 'GET', url: '/api/push/vapid' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicKey: VAPID_KEYS.publicKey });
  });
});

describe('POST /api/push/subscribe', () => {
  it('returns 401 without a session cookie', async () => {
    const app = buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: { subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } } },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for a malformed subscription', async () => {
    const app = buildTestApp();
    const alice = await registerAndLogin(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie: alice.cookie },
      payload: { subscription: { endpoint: 'https://push.example/x' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_subscription');
  });

  it('inserts a new push_subs row for the caller and returns 201', async () => {
    const app = buildTestApp();
    const alice = await registerAndLogin(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie: alice.cookie },
      payload: {
        subscription: { endpoint: 'https://push.example/alice', keys: { p256dh: 'p-key', auth: 'a-key' } },
      },
    });

    expect(res.statusCode).toBe(201);
    const row = app.db.prepare('SELECT * FROM push_subs WHERE endpoint = ?').get('https://push.example/alice');
    expect(row.user_id).toBe(alice.id);
    expect(row.p256dh).toBe('p-key');
    expect(row.auth).toBe('a-key');
  });

  it('upserts by endpoint: a second subscribe to the same endpoint replaces the row instead of duplicating it', async () => {
    const app = buildTestApp();
    const alice = await registerAndLogin(app);
    const endpoint = 'https://push.example/shared';

    await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie: alice.cookie },
      payload: { subscription: { endpoint, keys: { p256dh: 'old-p', auth: 'old-a' } } },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie: alice.cookie },
      payload: { subscription: { endpoint, keys: { p256dh: 'new-p', auth: 'new-a' } } },
    });

    expect(second.statusCode).toBe(201);
    const rows = app.db.prepare('SELECT * FROM push_subs WHERE endpoint = ?').all(endpoint);
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe('new-p');
    expect(rows[0].auth).toBe('new-a');
  });
});
