import webpush from 'web-push';

// A single unreachable/slow push endpoint must never make sendPush (and
// therefore whatever triggered it) hang indefinitely — some push services
// have been known to accept a connection and simply never respond. 5s is
// generous for a real push service and short enough that a request path
// calling sendPush stays responsive.
const DEFAULT_PUSH_TIMEOUT_MS = 5000;

// Races `promise` against a timer, rejecting with a distinct error if `ms`
// elapses first. The timer is cleared either way so a fast-resolving
// `promise` doesn't leave a dangling handle around, and is unref()'d so an
// in-flight one can never keep the process alive on its own.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`push timed out after ${ms}ms`), { code: 'PUSH_TIMEOUT' }));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
export function createPush(config, db, hasOpenSocket, logger = console, pushTimeoutMs = DEFAULT_PUSH_TIMEOUT_MS) {
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

    // Send to every recipient regardless of open sockets: a user may be
    // online on one device while their phone's tab is closed — the phone
    // must still get the push. The service worker suppresses the
    // notification when a visible client is already showing the app.
    const targetIds = ids;

    const placeholders = targetIds.map(() => '?').join(',');
    const subs = db.prepare(`SELECT * FROM push_subs WHERE user_id IN (${placeholders})`).all(...targetIds);
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await withTimeout(
            webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              body,
            ),
            pushTimeoutMs,
          );
        } catch (err) {
          const status = err?.statusCode;
          if (status === 404 || status === 410) {
            db.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id);
          }
          // Any other failure (network blip, 5xx from the push service, or
          // our own PUSH_TIMEOUT above) is swallowed on purpose — a push
          // delivery hiccup must never break the message-send request path
          // that triggered it. A timeout doesn't mean the subscription is
          // dead (unlike 404/410), so its row is kept.
        }
      }),
    );
  }

  return { sendPush };
}
