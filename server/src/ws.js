import websocketPlugin from '@fastify/websocket';
import { requireUser } from './auth.js';

// Creates one WS module instance: an in-memory connection registry
// (Map<userId, Set<WebSocket>>) plus the two things the rest of the app
// needs from it — a route registrar and a fan-out sender. Kept as a factory
// (not module-level state) so each buildApp() call — including every
// test's own app — gets an isolated registry; a single process-wide Map
// would leak "open socket" state from one test's app into another's.
export function createWs() {
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
      instance.get('/ws', { websocket: true, preHandler: requireUser }, (socket, request) => {
        const userId = request.user.id;
        addConnection(userId, socket);

        socket.on('close', () => removeConnection(userId, socket));
        // A socket can error out without a following 'close' in some edge
        // cases (e.g. an abrupt client-side crash) — make sure the registry
        // doesn't keep a dead reference around either way.
        socket.on('error', () => removeConnection(userId, socket));
      });
    });
  }

  return { registerWsRoute, pushToUsers, hasOpenSocket };
}
