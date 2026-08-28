import { requireUser } from '../auth.js';

export async function registerPushRoutes(app) {
  // Exempt from auth per spec — the frontend needs the public key before a
  // session exists (it's asked for as part of registering the service
  // worker's push subscription, which can happen right after login but
  // must not itself require one).
  app.get('/push/vapid', async (request, reply) => {
    const vapid = app.config.vapid;
    if (!vapid) {
      return reply.code(404).send({ error: 'push_disabled' });
    }
    return reply.send({ publicKey: vapid.publicKey });
  });

  app.post('/push/subscribe', { preHandler: requireUser }, async (request, reply) => {
    const db = app.db;
    const subscription = request.body?.subscription;
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;

    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
      return reply.code(400).send({ error: 'invalid_subscription' });
    }

    const now = Date.now();
    // Upsert by endpoint (unique per the schema): a resubscription with the
    // same endpoint (e.g. keys rotated, or a different user on a shared
    // device re-subscribing) replaces the prior row's owner/keys rather
    // than erroring or duplicating.
    db.prepare(
      `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(request.user.id, endpoint, p256dh, auth, now);

    return reply.code(201).send({ ok: true });
  });
}
