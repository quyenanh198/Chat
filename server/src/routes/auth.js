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

export async function registerAuthRoutes(app) {
  // First registered user becomes admin and needs no invite; every user
  // after that must supply an unused invite code (marked used on success).
  app.post('/auth/register', async (request, reply) => {
    const { username, password, invite } = request.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: 'username_and_password_required' });
    }

    // Hash BEFORE touching the db. argon2.hash awaits onto the event loop;
    // if the count/invite/username reads happened before that await and the
    // insert after, two concurrent registrations could interleave between
    // them (both see "no users yet", or both see an unused invite) and both
    // write. Hashing first means everything below — reads, checks, and
    // writes — runs inside one synchronous db.transaction() with no await
    // in the middle, so no other request's handler can interleave with it.
    const passHash = await hashPassword(password);

    const db = app.db;
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

  app.post('/auth/login', async (request, reply) => {
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
