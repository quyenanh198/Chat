import websocketPlugin from '@fastify/websocket';
import { requireUser } from './auth.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
// A socket that misses this many consecutive pings (i.e. never answers with
// a pong in between) is presumed dead and terminated.
const MAX_MISSED_PONGS = 2;

// True when `origin` (an Origin request header value, e.g.
// "https://evil.example") names a different host than `hostHeader` (the
// Host header of the same request, e.g. "chat.example:8082"). Same-origin
// WS upgrades from a browser always carry a matching Origin; a cross-site
// page trying to ride the victim's session cookie into our /ws endpoint
// sends its own (different) Origin. Non-browser clients (curl, the ws
// library used in our own tests, mobile apps) typically send no Origin at
// all, which this deliberately does NOT reject — there is no cookie-riding
// risk for a client that isn't a browser honoring the Origin header in the
// first place, and rejecting absent-Origin would break every non-browser
// client for no security benefit.
function isCrossOrigin(origin, hostHeader) {
  if (!origin) return false;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Unparseable Origin header — fail closed rather than let a malformed
    // value slip through as "same-origin".
    return true;
  }
  return originHost !== hostHeader;
}

// Fastify preHandler: rejects (403) an upgrade whose Origin header names a
// different host than the request's own Host header. Runs before
// `requireUser` so a cross-site page can't even get as far as the cookie
// check. See isCrossOrigin's comment for why an absent Origin is allowed
// through.
async function checkOrigin(request, reply) {
  if (isCrossOrigin(request.headers.origin, request.headers.host)) {
    return reply.code(403).send({ error: 'origin_not_allowed' });
  }
}

// Creates one WS module instance: an in-memory connection registry
// (Map<userId, Set<WebSocket>>) plus the two things the rest of the app
// needs from it — a route registrar and a fan-out sender. Kept as a factory
// (not module-level state) so each buildApp() call — including every
// test's own app — gets an isolated registry; a single process-wide Map
// would leak "open socket" state from one test's app into another's.
//
// `heartbeatIntervalMs`/`maxMissedPongs` are only ever overridden by tests
// (buildApp forwards wsHeartbeatIntervalMs/wsMaxMissedPongs) so a heartbeat
// test doesn't have to wait out the real 30s cadence.
export function createWs({ heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS, maxMissedPongs = MAX_MISSED_PONGS } = {}) {
  const connections = new Map();

  function addConnection(userId, socket) {
    let set = connections.get(userId);
    if (!set) {
      set = new Set();
      connections.set(userId, set);
    }
    set.add(socket);
  }

  function removeConnection(userId, socket) {
    const set = connections.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) connections.delete(userId);
  }

  // True when `userId` currently has at least one open websocket connected.
  // push.js uses this to skip web-push for anyone already reachable live.
  function hasOpenSocket(userId) {
    const set = connections.get(userId);
    return Boolean(set && set.size > 0);
  }

  // Sends `event` (JSON-serialized once) to every open socket belonging to
  // any of `userIds`. Silently skips users with no connection and any
  // socket that isn't in the OPEN state (e.g. mid-handshake or mid-close).
  function pushToUsers(userIds, event) {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    if (ids.length === 0) return;

    const payload = JSON.stringify(event);
    for (const userId of ids) {
      const set = connections.get(userId);
      if (!set) continue;
      for (const socket of set) {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload);
        }
      }
    }
  }

  // Pings every open connection on a fixed interval and terminates any
  // socket that has failed to answer with a pong for `maxMissedPongs`
  // consecutive pings — catches half-open connections (e.g. a phone that
  // dropped off wifi without a clean TCP close) that would otherwise sit in
  // the registry forever, silently "reachable" as far as
  // hasOpenSocket/pushToUsers are concerned. `socket.missedPongs` increments
  // every tick and resets to 0 on 'pong'; with maxMissedPongs=2 a socket is
  // terminated on the tick after its 2nd consecutive unanswered ping (i.e.
  // ~3 intervals of total silence). unref()'d so it can never keep the
  // process alive on its own, matching cleanup.js's own interval; the
  // returned stop() is wired to the Fastify instance's 'onClose' so tests
  // that build many short-lived apps don't leak timers.
  function startHeartbeat() {
    const timer = setInterval(() => {
      for (const [userId, sockets] of connections) {
        for (const socket of sockets) {
          if (socket.readyState !== socket.OPEN) continue;
          socket.missedPongs = (socket.missedPongs ?? 0) + 1;
          if (socket.missedPongs > maxMissedPongs) {
            socket.terminate();
            // Don't wait on the 'close' event for registry cleanup — it
            // fires asynchronously and a terminated socket must stop
            // counting as "open" (for hasOpenSocket/pushToUsers)
            // immediately. The 'close' handler below still fires afterward
            // and is a safe no-op by then (removeConnection is idempotent).
            removeConnection(userId, socket);
            continue;
          }
          socket.ping();
        }
      }
    }, heartbeatIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  // Registers @fastify/websocket and the GET /ws route on `app`. Must be
  // called before any other route is registered on `app` — per
  // @fastify/websocket's own README, it needs to be able to intercept the
  // raw HTTP upgrade for every path (to reject upgrades on non-websocket
  // routes) — and after @fastify/cookie is registered, since the /ws route
  // authenticates with the same `requireUser` preHandler the REST routes
  // use, which reads request.cookies.
  //
  // The route is added inside its own nested `app.register()` rather than
  // via a plain `app.get()` called right after `app.register(websocketPlugin)`
  // on purpose: `register()` queues a plugin to boot through avvio — it does
  // not run synchronously — so a `.get('/ws', {websocket:true}, ...)` added
  // immediately after would be declared before the plugin's `onRoute` hook
  // exists to recognize and wrap it as a websocket route (it would silently
  // stay a plain HTTP handler invoked as (request, reply), never getting a
  // (socket, request) upgrade at all). Nesting the route registration in its
  // own `app.register()` call queues it as the next item in the same avvio
  // boot chain, so it's only added once the websocket plugin has fully
  // finished loading — the same "register the dependency, then register
  // what needs it" ordering already used for cookie/multipart vs. the /api
  // routes elsewhere in this app.
  //
  // `requireUser` runs as an ordinary preHandler here: @fastify/websocket
  // runs onRequest/preParsing/preValidation/preHandler before upgrading the
  // connection, so a reply sent from requireUser (401) rejects the upgrade
  // before the handler below ever runs.
  function registerWsRoute(app) {
    app.register(websocketPlugin);

    app.register(async (instance) => {
      instance.get(
        '/ws',
        { websocket: true, preHandler: [checkOrigin, requireUser] },
        (socket, request) => {
          const userId = request.user.id;
          addConnection(userId, socket);

          socket.missedPongs = 0;
          socket.on('pong', () => {
            socket.missedPongs = 0;
          });

          socket.on('close', () => removeConnection(userId, socket));
          // A socket can error out without a following 'close' in some edge
          // cases (e.g. an abrupt client-side crash) — make sure the registry
          // doesn't keep a dead reference around either way.
          socket.on('error', () => removeConnection(userId, socket));
        },
      );
    });

    const stopHeartbeat = startHeartbeat();
    app.addHook('onClose', (_instance, done) => {
      stopHeartbeat();
      done();
    });
  }

  return { registerWsRoute, pushToUsers, hasOpenSocket };
}
