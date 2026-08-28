import webpush from 'web-push';

// Creates one push module instance bound to a single app's config/db/ws
// registry (mirrors the createWs() factory shape — keeps state isolated
// per buildApp() call instead of leaking across tests via module globals).
//
// `config.vapid` is either {publicKey, privateKey, subject} or null
// (loadConfig returns null whenever any of VAPID_PUBLIC_KEY/
// VAPID_PRIVATE_KEY/VAPID_SUBJECT is unset). When null, push is disabled
// for the lifetime of this instance: a single warning is logged right here
// at construction time ("init ... log once"), and the returned sendPush
// becomes a permanent no-op that never throws and never touches the db —
// safe to call unconditionally from notifyNewMessage regardless of whether
// this deployment has push configured.
//
// `hasOpenSocket(userId)` — typically ws.js's hasOpenSocket — lets sendPush
// skip anyone already reachable live over their websocket, per spec: push
// only goes to participants without an open connection.
export function createPush(config, db, hasOpenSocket, logger = console) {
  const vapid = config.vapid;

  if (vapid) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  } else {
    logger.warn(
      '[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT not fully set — push notifications disabled',
    );
  }

  // Sends `payload` (JSON-serialized) as a web-push notification to every
  // subscription belonging to any of `userIds` that does NOT currently have
  // an open websocket. Never throws: an individual subscription's send
  // failure is caught per-subscription so one bad endpoint can't sink the
  // rest, and a 404/410 response (the push service telling us the
  // subscription is gone) deletes that push_subs row.
  async function sendPush(userIds, payload) {
    if (!vapid) return;

    const ids = Array.isArray(userIds) ? userIds : [userIds];
    if (ids.length === 0) return;

    const targetIds = ids.filter((id) => !hasOpenSocket(id));
    if (targetIds.length === 0) return;

    const placeholders = targetIds.map(() => '?').join(',');
    const subs = db.prepare(`SELECT * FROM push_subs WHERE user_id IN (${placeholders})`).all(...targetIds);
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
          );
        } catch (err) {
          const status = err?.statusCode;
          if (status === 404 || status === 410) {
            db.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id);
          }
          // Any other failure (network blip, 5xx from the push service) is
          // swallowed on purpose — a push delivery hiccup must never break
          // the message-send request path that triggered it.
        }
      }),
    );
  }

  return { sendPush };
}
