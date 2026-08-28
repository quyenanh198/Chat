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

function buildTestApp() {
  const { db, mediaDir } = makeTestDb();
  const config = loadConfig({ SESSION_SECRET: 'test-secret' });
  return buildApp({ config, db, mediaDir });
}

function registerUser(app, body) {
  return app.inject({ method: 'POST', url: '/api/auth/register', payload: body });
}

async function registerAdminAndGetCookie(app) {
  const res = await registerUser(app, { username: 'alice', password: 'password123' });
  return extractSessionCookie(res);
}

async function createInvite(app, adminCookie) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/invites',
    headers: { cookie: adminCookie },
  });
  return res.json().code;
}

describe('POST /api/auth/register', () => {
  it('makes the first registered user an admin with no invite required', async () => {
    const app = buildTestApp();

    const res = await registerUser(app, { username: 'alice', password: 'password123' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.username).toBe('alice');
    expect(body.user.is_admin).toBe(true);
    expect(body.user.media_mode).toBe('once');
    expect(body.user.pass_hash).toBeUndefined();
    expect(extractSessionCookie(res)).toMatch(/^lb_session=.+/);
  });

  it('rejects a second registration with no invite code', async () => {
    const app = buildTestApp();
    await registerUser(app, { username: 'alice', password: 'password123' });

    const res = await registerUser(app, { username: 'bob', password: 'password123' });

    expect(res.statusCode).toBe(403);
  });

  it('accepts a second registration with a valid invite code, as a non-admin', async () => {
    const app = buildTestApp();
    const adminCookie = await registerAdminAndGetCookie(app);
    const code = await createInvite(app, adminCookie);

    const res = await registerUser(app, { username: 'bob', password: 'password123', invite: code });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.username).toBe('bob');
    expect(body.user.is_admin).toBe(false);
  });

  it('rejects reusing an already-used invite code', async () => {
    const app = buildTestApp();
    const adminCookie = await registerAdminAndGetCookie(app);
    const code = await createInvite(app, adminCookie);
    await registerUser(app, { username: 'bob', password: 'password123', invite: code });

    const res = await registerUser(app, { username: 'carol', password: 'password123', invite: code });

    expect(res.statusCode).toBe(403);
  });

  it('rejects an unknown invite code', async () => {
    const app = buildTestApp();
    await registerAdminAndGetCookie(app);

    const res = await registerUser(app, {
      username: 'bob',
      password: 'password123',
      invite: 'deadbeef',
    });

    expect(res.statusCode).toBe(403);
  });

  // The register handler consumes an invite with a conditional
  // `UPDATE invites SET used_by = ? WHERE code = ? AND used_by IS NULL`
  // inside a single synchronous db.transaction() — that's what actually
  // enforces single-use, independent of the earlier SELECT-based check.
  // The interleaved-request race itself can't be reproduced in a
  // single-threaded test process (there's no await between the read and
  // the write for it to land in), so this exercises the guarantee the way
  // it's observable: the UPDATE really flips used_by, and a second,
  // sequential attempt with the same code is rejected because of it.
  it('marks an invite consumed via the conditional UPDATE so it cannot be replayed', async () => {
    const app = buildTestApp();
    const adminCookie = await registerAdminAndGetCookie(app);
    const code = await createInvite(app, adminCookie);

    const first = await registerUser(app, { username: 'bob', password: 'password123', invite: code });
    expect(first.statusCode).toBe(201);
    const bobId = first.json().user.id;

    const inviteRow = app.db.prepare('SELECT used_by FROM invites WHERE code = ?').get(code);
    expect(inviteRow.used_by).toBe(bobId);

    const second = await registerUser(app, { username: 'carol', password: 'password123', invite: code });
    expect(second.statusCode).toBe(403);
    expect(second.json().error).toBe('invalid_invite');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials and sets the session cookie', async () => {
    const app = buildTestApp();
    await registerUser(app, { username: 'alice', password: 'password123' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'password123' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('alice');
    expect(extractSessionCookie(res)).toMatch(/^lb_session=.+/);
  });

  it('rejects an incorrect password with 401', async () => {
    const app = buildTestApp();
    await registerUser(app, { username: 'alice', password: 'password123' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'wrong-password' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown username with 401', async () => {
    const app = buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ghost', password: 'password123' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const app = buildTestApp();
    const cookie = await registerAdminAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const cleared = res.headers['set-cookie'];
    const cookies = Array.isArray(cleared) ? cleared : [cleared];
    expect(cookies.some((c) => c.startsWith('lb_session=;') || /Max-Age=0/i.test(c))).toBe(true);
  });
});

describe('GET /api/me', () => {
  it('returns 401 without a session cookie', async () => {
    const app = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/me' });

    expect(res.statusCode).toBe(401);
  });

  it('returns the current user for a valid session', async () => {
    const app = buildTestApp();
    const cookie = await registerAdminAndGetCookie(app);

    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: expect.any(Number),
      username: 'alice',
      is_admin: true,
      media_mode: 'once',
    });
  });
});

describe('PATCH /api/me/settings', () => {
  it('updates media_mode to 24h', async () => {
    const app = buildTestApp();
    const cookie = await registerAdminAndGetCookie(app);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/settings',
      headers: { cookie },
      payload: { media_mode: '24h' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.media_mode).toBe('24h');
  });

  it('rejects an invalid media_mode with 400', async () => {
    const app = buildTestApp();
    const cookie = await registerAdminAndGetCookie(app);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/settings',
      headers: { cookie },
      payload: { media_mode: 'weekly' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without a session cookie', async () => {
    const app = buildTestApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/settings',
      payload: { media_mode: '24h' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/invites', () => {
  it('lets an admin create an 8-hex-char invite code', async () => {
    const app = buildTestApp();
    const cookie = await registerAdminAndGetCookie(app);

    const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { cookie } });

    expect(res.statusCode).toBe(201);
    expect(res.json().code).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects a non-admin user with 403', async () => {
    const app = buildTestApp();
    const adminCookie = await registerAdminAndGetCookie(app);
    const code = await createInvite(app, adminCookie);
    const bobRes = await registerUser(app, { username: 'bob', password: 'password123', invite: code });
    const bobCookie = extractSessionCookie(bobRes);

    const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { cookie: bobCookie } });

    expect(res.statusCode).toBe(403);
  });

  it('returns 401 without a session cookie', async () => {
    const app = buildTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/invites' });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/users', () => {
  it('returns 401 without a session cookie', async () => {
    const app = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/users' });

    expect(res.statusCode).toBe(401);
  });

  it('returns all users except the requester with only id and username, ordered by username', async () => {
    const app = buildTestApp();
    const adminCookie = await registerAdminAndGetCookie(app);
    const code = await createInvite(app, adminCookie);
    const bobRes = await registerUser(app, { username: 'bob', password: 'password123', invite: code });
    const bobCookie = extractSessionCookie(bobRes);

    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: bobCookie } });

    expect(res.statusCode).toBe(200);
    const users = res.json();
    expect(users).toHaveLength(1);
    expect(users[0]).toEqual({
      id: expect.any(Number),
      username: 'alice',
    });
    expect(users[0].pass_hash).toBeUndefined();
    expect(users[0].media_mode).toBeUndefined();
  });
});
