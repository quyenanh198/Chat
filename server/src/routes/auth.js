import {
  hashPassword,
  verifyPassword,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  serializeUser,
} from '../auth.js';

export async function registerAuthRoutes(app) {
  // First registered user becomes admin and needs no invite; every user
  // after that must supply an unused invite code (marked used on success).
  app.post('/auth/register', async (request, reply) => {
    const { username, password, invite } = request.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: 'username_and_password_required' });
    }

    const db = app.db;
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
    const isFirstUser = count === 0;

    let inviteRow = null;
    if (!isFirstUser) {
      if (!invite) {
        return reply.code(403).send({ error: 'invite_required' });
      }
      inviteRow = db.prepare('SELECT * FROM invites WHERE code = ?').get(invite);
      if (!inviteRow || inviteRow.used_by) {
        return reply.code(403).send({ error: 'invalid_invite' });
      }
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return reply.code(409).send({ error: 'username_taken' });
    }

    const passHash = await hashPassword(password);
    const now = Date.now();
    const info = db
      .prepare('INSERT INTO users (username, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run(username, passHash, isFirstUser ? 1 : 0, now);
    const userId = info.lastInsertRowid;

    if (inviteRow) {
      db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(userId, inviteRow.code);
    }

    const user = db
      .prepare('SELECT id, username, is_admin, media_mode FROM users WHERE id = ?')
      .get(userId);
    const token = await signSession(userId, app.config.sessionSecret);
    setSessionCookie(reply, token);

    return reply.code(201).send({ user: serializeUser(user) });
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
