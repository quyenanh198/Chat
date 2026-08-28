import {
  hashPassword,
  verifyPassword,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  serializeUser,
} from '../auth.js';

// Thrown from inside the register transaction when the conditional invite
// UPDATE affects 0 rows — i.e. the code was already consumed by the time we
// tried to claim it. Rolls the transaction (and the user INSERT) back.
class InviteAlreadyConsumedError extends Error {}

// better-sqlite3 throws a SqliteError with this message shape on a UNIQUE
// violation (e.g. two transactions both slipping past the pre-check for the
// same username). Detected by message since the error class isn't exported.
function isUniqueConstraintError(err) {
  return Boolean(err && typeof err.message === 'string' && /UNIQUE constraint failed/i.test(err.message));
}

const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 32;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;
const MIN_PASSWORD_LENGTH = 12;

function isValidUsername(username) {
  return (
    typeof username === 'string' &&
    username.length >= MIN_USERNAME_LENGTH &&
    username.length <= MAX_USERNAME_LENGTH &&
    USERNAME_PATTERN.test(username)
  );
}

// Cheap, synchronous, read-only checks run BEFORE the expensive argon2 hash
// below — a flood of registration attempts with a bogus/reused invite code
// or an already-taken username would otherwise force the server to pay a
// full argon2 hash (deliberately slow, that's the point of it) per attempt,
// which is itself a cheap CPU-exhaustion DoS. Returns {status, error} to
// reject early, or null when nothing obviously wrong was found.
//
// This is a fast-path rejection ONLY — it is not the authoritative gate.
// registerTx below re-runs the equivalent checks transactionally and is
// what actually enforces correctness under concurrent requests (see its own
// comment); this pre-check must never be relied on for that, and skipping
// it (e.g. if it has a stale read) only costs an extra wasted hash, not a
// security guarantee.
function evaluateRegistration(db, { username, invite, bootstrapInvite }) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  const isFirstUser = count === 0;

  if (isFirstUser) {
    // BOOTSTRAP_INVITE (when configured) closes the "first visitor becomes
    // admin" window: the first registration must present it too.
    if (bootstrapInvite && invite !== bootstrapInvite) {
      return { status: 403, error: 'invite_required' };
    }
  } else {
    if (!invite) {
      return { status: 403, error: 'invite_required' };
    }
    const inviteRow = db.prepare('SELECT used_by FROM invites WHERE code = ?').get(invite);
    if (!inviteRow || inviteRow.used_by) {
      return { status: 403, error: 'invalid_invite' };
    }
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return { status: 409, error: 'username_taken' };
  }

  return null;
}

// Login/register are the two routes actually worth brute-forcing (password
// guessing, invite-code guessing) so they get a much stricter limit than
// app.js's global default — see app.js's own rate-limit registration for
// the shared keyGenerator (CF-Connecting-IP else request.ip) this inherits.
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export async function registerAuthRoutes(app) {
  // First registered user becomes admin and needs no invite (unless
  // BOOTSTRAP_INVITE is configured, see evaluateRegistration); every user
  // after that must supply an unused invite code (marked used on success).
  app.post('/auth/register', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const { username, password, invite } = request.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: 'username_and_password_required' });
    }
    if (!isValidUsername(username)) {
      return reply.code(400).send({ error: 'invalid_username' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: 'password_too_short' });
    }

    const db = app.db;

    const precheck = evaluateRegistration(db, { username, invite, bootstrapInvite: app.config.bootstrapInvite });
    if (precheck) {
      return reply.code(precheck.status).send({ error: precheck.error });
    }

    // Hash BEFORE touching the db. argon2.hash awaits onto the event loop;
    // if the count/invite/username reads happened before that await and the
    // insert after, two concurrent registrations could interleave between
    // them (both see "no users yet", or both see an unused invite) and both
    // write. Hashing first means everything below — reads, checks, and
    // writes — runs inside one synchronous db.transaction() with no await
    // in the middle, so no other request's handler can interleave with it.
    const passHash = await hashPassword(password);

    const now = Date.now();

    const registerTx = db.transaction(() => {
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
      const isFirstUser = count === 0;

      let inviteRow = null;
      if (!isFirstUser) {
        if (!invite) {
          return { status: 403, error: 'invite_required' };
        }
        inviteRow = db.prepare('SELECT * FROM invites WHERE code = ?').get(invite);
        if (!inviteRow || inviteRow.used_by) {
          return { status: 403, error: 'invalid_invite' };
        }
      }

      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        return { status: 409, error: 'username_taken' };
      }

      const info = db
        .prepare('INSERT INTO users (username, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
        .run(username, passHash, isFirstUser ? 1 : 0, now);
      const userId = info.lastInsertRowid;

      if (inviteRow) {
        // Conditional on used_by IS NULL: this is the actual single-use
        // guarantee, independent of the SELECT check above. changes === 0
        // means someone else already claimed the code — roll back rather
        // than mint a user with no valid invite.
        const consumed = db
          .prepare('UPDATE invites SET used_by = ? WHERE code = ? AND used_by IS NULL')
          .run(userId, inviteRow.code);
        if (consumed.changes === 0) {
          throw new InviteAlreadyConsumedError();
        }
      }

      const user = db
        .prepare('SELECT id, username, is_admin, media_mode FROM users WHERE id = ?')
        .get(userId);
      return { status: 201, user };
    });

    let result;
    try {
      result = registerTx();
    } catch (err) {
      if (err instanceof InviteAlreadyConsumedError) {
        return reply.code(403).send({ error: 'invalid_invite' });
      }
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({ error: 'username_taken' });
      }
      throw err;
    }

    if (result.status !== 201) {
      return reply.code(result.status).send({ error: result.error });
    }

    const token = await signSession(result.user.id, app.config.sessionSecret);
    setSessionCookie(reply, token);

    return reply.code(201).send({ user: serializeUser(result.user) });
  });

  app.post('/auth/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const { username, password } = request.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: 'username_and_password_required' });
    }

    const user = app.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await verifyPassword(user.pass_hash, password))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const token = await signSession(user.id, app.config.sessionSecret);
    setSessionCookie(reply, token);

    return reply.send({ user: serializeUser(user) });
  });

  app.post('/auth/logout', async (request, reply) => {
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });
}
