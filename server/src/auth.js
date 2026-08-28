import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE_NAME = 'lb_session';
const JWT_ALG = 'HS256';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Hashes a plaintext password for storage (users.pass_hash).
export function hashPassword(password) {
  return argon2.hash(password);
}

// Verifies a plaintext password against a stored argon2 hash. Never throws —
// a malformed hash or wrong password both resolve to false.
export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// Signs a stateless session JWT (sub = user id) with the app's session secret.
export function signSession(userId, sessionSecret) {
  const key = new TextEncoder().encode(sessionSecret);
  return new SignJWT({ sub: String(userId) })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key);
}

// Verifies a session JWT and returns its payload. Throws if invalid/expired.
async function verifySession(token, sessionSecret) {
  const key = new TextEncoder().encode(sessionSecret);
  const { payload } = await jwtVerify(token, key, { algorithms: [JWT_ALG] });
  return payload;
}

export function setSessionCookie(reply, token) {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(reply) {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

// Strips internal columns (pass_hash) and normalizes is_admin to a boolean
// for anything sent back to the client.
export function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    is_admin: !!user.is_admin,
    media_mode: user.media_mode,
  };
}

// Fastify preHandler: reads the lb_session cookie, verifies the JWT, loads
// the user from the db, and attaches it as req.user = {id, username,
// is_admin, media_mode}. Replies 401 and short-circuits the route on any
// failure (missing cookie, bad/expired token, or deleted user).
export async function requireUser(request, reply) {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  let payload;
  try {
    payload = await verifySession(token, request.server.config.sessionSecret);
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const userId = Number(payload.sub);
  const user = request.server.db
    .prepare('SELECT id, username, is_admin, media_mode FROM users WHERE id = ?')
    .get(userId);
  if (!user) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  request.user = serializeUser(user);
}
