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
  return buildApp({ config, db, mediaDir, logger: false });
}

function registerUser(app, body) {
  return app.inject({ method: 'POST', url: '/api/auth/register', payload: body });
}

async function registerAdminAndGetCookie(app) {
  const res = await registerUser(app, { username: 'alice', password: 'password1234' });
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

    const res = await registerUser(app, { username: 'alice', password: 'password1234' });

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
    await registerUser(app, { username: 'alice', password: 'password1234' });

    const res = await registerUser(app, { username: 'bob', password: 'password1234' });

    expect(res.statusCode).toBe(403);
  });

  it('accepts a second registration with a valid invite code, as a non-admin', async () => {
    const app = buildTestApp();
    const adminCookie = await registerAdminAndGetCookie(app);
    const code = await createInvite(app, adminCookie);

    const res = await registerUser(app, { username: 'bob', password: 'password1234', invite: code });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.username).toBe('bob');
    expect(body.user.is_admin).toBe(false);
  });

  it('rejects reusing an already-used invite code', async () => {
    const app = buildTestApp();
    const adminCookie = await registerAdminAndGetCookie(app);
    const code = await createInvite(app, adminCookie);
    await registerUser(app, { username: 'bob', password: 'password1234', invite: code });

    const res = await registerUser(app, { username: 'carol', password: 'password1234', invite: code });

    expect(res.statusCode).toBe(403);
  });

  it('rejects an unknown invite code', async () => {
    const app = buildTestApp();
    await registerAdminAndGetCookie(app);

    const res = await registerUser(app, {
      username: 'bob',
      password: 'password1234',
      invite: 'deadbeef',
    });

    expect(res.statusCode).toBe(403);
  });

  it('rejects a password shorter than 12 characters with 400 password_too_short', async () => {
    const app = buildTestApp();

    const res = await registerUser(app, { username: 'alice', password: 'short11chr' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('password_too_short');
  });

  it('accepts a password exactly 12 characters long', async () => {
    const app = buildTestApp();

    const res = await registerUser(app, { username: 'alice', password: '123456789012' });

    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(33)],
    ['contains a space', 'bad user'],
    ['contains a dash', 'bad-user'],
    ['contains punctuation', 'bad.user!'],
  ])('rejects an invalid username (%s) with 400 invalid_username', async (_label, username) => {
    const app = buildTestApp();

    const res = await registerUser(app, { username, password: 'password1234' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_username');
  });

  it('accepts a username with letters, digits, and underscores at the length boundaries', async () => {
    const app = buildTestApp();

    const res = await registerUser(app, { username: 'ab_'.padEnd(32, '9'), password: 'password1234' });

    expect(res.statusCode).toBe(201);
  });

  // I1: the count/invite/username-free checks run as a cheap synchronous
  // pre-check BEFORE the (deliberately slow) argon2 hash, so a bogus invite
  // can't be used to force a hash per attempt. Functionally this must still
  // produce the exact same rejection the authoritative registerTx would —
  // this test only observes the outward behavior (still 403 for a bogus
  // invite, and every pre-existing register test above/below still passes),
  // since the pre-check's entire point is to be unobservable except in CPU
  // cost, which isn't something a black-box HTTP test can assert on.
  it('still rejects a bogus invite with 403 (fast pre-check path)', async () => {
    const app = buildTestApp();
    await registerAdminAndGetCookie(app);

    const res = await registerUser(app, { username: 'mallory', password: 'password1234', invite: 'no-such-code' });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('invalid_invite');
  });

  it('still rejects an already-taken username with 409 (fast pre-check path)', async () => {
    const app = buildTestApp();
    const adminCookie = await registerAdminAndGetCookie(app);
    const code = await createInvite(app, adminCookie);

    const res = await registerUser(app, { username: 'alice', password: 'password1234', invite: code });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('username_taken');
  });

  describe('with BOOTSTRAP_INVITE set', () => {
    function buildBootstrapApp() {
      return buildTestApp({ BOOTSTRAP_INVITE: 'let-me-in' });
    }

    it('rejects the very first registration with no invite', async () => {
      const app = buildBootstrapApp();

      const res = await registerUser(app, { username: 'alice', password: 'password1234' });

      expect(res.statusCode).toBe(403);
    });

    it('rejects the very first registration with the wrong invite', async () => {
      const app = buildBootstrapApp();

      const res = await registerUser(app, { username: 'alice', password: 'password1234', invite: 'guess' });

      expect(res.statusCode).toBe(403);
    });

    it('accepts the very first registration with the matching invite and makes it admin', async () => {
      const app = buildBootstrapApp();

      const res = await registerUser(app, {
        username: 'alice',
        password: 'password1234',
        invite: 'let-me-in',
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().user.is_admin).toBe(true);
    });

    it('still requires a normal invite for the second registration (bootstrap code does not work again)', async () => {
      const app = buildBootstrapApp();
      await registerUser(app, { username: 'alice', password: 'password1234', invite: 'let-me-in' });

      const res = await registerUser(app, {
        username: 'bob',
        password: 'password1234',
        invite: 'let-me-in',
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('without BOOTSTRAP_INVITE (default)', () => {
    it('still lets the first registration through with no invite at all', async () => {
      const app = buildTestApp();

      const res = await registerUser(app, { username: 'alice', password: 'password1234' });

      expect(res.statusCode).toBe(201);
      expect(res.json().user.is_admin).toBe(true);
    });
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

    const first = await registerUser(app, { username: 'bob', password: 'password1234', invite: code });
    expect(first.statusCode).toBe(201);
    const bobId = first.json().user.id;

    const inviteRow = app.db.prepare('SELECT used_by FROM invites WHERE code = ?').get(code);
    expect(inviteRow.used_by).toBe(bobId);

    const second = await registerUser(app, { username: 'carol', password: 'password1234', invite: code });
    expect(second.statusCode).toBe(403);
    expect(second.json().error).toBe('invalid_invite');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials and sets the session cookie', async () => {
    const app = buildTestApp();
    await registerUser(app, { username: 'alice', password: 'password1234' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'password1234' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('alice');
    expect(extractSessionCookie(res)).toMatch(/^lb_session=.+/);
  });

  it('rejects an incorrect password with 401', async () => {
    const app = buildTestApp();
    await registerUser(app, { username: 'alice', password: 'password1234' });

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
      payload: { username: 'ghost', password: 'password1234' },
    });

    expect(res.statusCode).toBe(401);
  });
});

// C1: /auth/login and /auth/register carry a much stricter per-route limit
// (10/min) than the app-wide default (300/min, see app.js) since they're
// the two routes actually worth brute-forcing. Every request counts toward
// the limit regardless of its own status code, so 10 attempts (successful
// or not) followed by an 11th is enough to prove the limit is wired up —
// no need to actually guess a password correctly.
describe('rate limiting', () => {
  it('returns 429 on the 11th rapid login attempt from the same client', async () => {
    const app = buildTestApp();
    await registerUser(app, { username: 'alice', password: 'password1234' });

    const attemptLogin = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'alice', password: 'wrong-password' },
      });

    for (let i = 0; i < 10; i++) {
      const res = await attemptLogin();
      expect(res.statusCode).toBe(401);
    }

    const eleventh = await attemptLogin();
    expect(eleventh.statusCode).toBe(429);
  });

  it('returns 429 on the 11th rapid register attempt from the same client', async () => {
    const app = buildTestApp();

    for (let i = 0; i < 10; i++) {
      // First succeeds (201, becomes admin); the rest 403 (no invite) — the
      // mix of outcomes doesn't matter, only that 10 requests reached the
      // route before the 11th is throttled.
      await registerUser(app, { username: `user${i}`, password: 'password1234' });
    }

    const eleventh = await registerUser(app, { username: 'user10', password: 'password1234' });

    expect(eleventh.statusCode).toBe(429);
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
      display_name: 'alice',
      avatar_at: null,
    });
  });

  // M1: the security-header onSend hook in app.js runs for every response —
  // asserted here on a plain authenticated GET, but it's not specific to
  // this route (see app.js's own comment for why each header matters).
  it('sets nosniff/no-referrer/frame-ancestors security headers', async () => {
    const app = buildTestApp();
    const cookie = await registerAdminAndGetCookie(app);

    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
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
    const bobRes = await registerUser(app, { username: 'bob', password: 'password1234', invite: code });
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

  it('returns all users except the requester with public profile fields, ordered by username', async () => {
    const app = buildTestApp();
    const adminCookie = await registerAdminAndGetCookie(app);
    const code = await createInvite(app, adminCookie);
    const bobRes = await registerUser(app, { username: 'bob', password: 'password1234', invite: code });
    const bobCookie = extractSessionCookie(bobRes);

    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: bobCookie } });

    expect(res.statusCode).toBe(200);
    const users = res.json();
    expect(users).toHaveLength(1);
    expect(users[0]).toEqual({
      id: expect.any(Number),
      username: 'alice',
      display_name: null,
      avatar_at: null,
    });
    expect(users[0].pass_hash).toBeUndefined();
    expect(users[0].media_mode).toBeUndefined();
  });
});
