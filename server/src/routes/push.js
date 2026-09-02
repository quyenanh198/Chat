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

  // Which devices of mine are registered — the Settings screen compares the
  // endpoints against this browser's own subscription to say "this device:
  // on/off" instead of trusting Notification.permission alone.
  app.get('/push/status', { preHandler: requireUser }, async (request, reply) => {
    const rows = app.db
      .prepare('SELECT endpoint, created_at FROM push_subs WHERE user_id = ? ORDER BY created_at')
      .all(request.user.id);
    return reply.send({ enabled: Boolean(app.config.vapid), devices: rows });
  });

  // Self-test: push a notification to every device of the caller and report
  // what each push service answered (201 = accepted).
  app.post('/push/test', { preHandler: requireUser }, async (request, reply) => {
    if (!app.config.vapid) {
      return reply.code(404).send({ error: 'push_disabled' });
    }
    const results = await app.sendPush([request.user.id], {
      title: '🔔 Thử thông báo Lazybutts',
      body: 'Thấy dòng này là thông báo hoạt động rồi!',
      url: '/settings',
    });
    return reply.send({
      sent: results.filter((r) => r.status >= 200 && r.status < 300).length,
      results: results.map((r) => {
        let host = '';
        try { host = new URL(r.endpoint).host; } catch { host = ''; }
        return { status: r.status, error: r.error, host };
      }),
    });
  });
}
