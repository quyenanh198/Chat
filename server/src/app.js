import { createReadStream, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMeRoutes } from './routes/me.js';
import { registerUsersRoutes } from './routes/users.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerGifRoutes } from './routes/gif.js';
import { registerStickerRoutes } from './routes/stickers.js';
import { registerEmbedRoutes } from './routes/embed.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerStoryRoutes } from './routes/stories.js';
import { registerPushRoutes } from './routes/push.js';
import { createWs } from './ws.js';
import { createPush } from './push.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default location of the built web app relative to this file
// (server/src/app.js -> ../../web/dist), used whenever buildApp() isn't
// given an explicit webDistDir. Overridable mainly for tests.
const DEFAULT_WEB_DIST_DIR = resolve(__dirname, '../../web/dist');

// Truncates a text message body to a short push-notification excerpt.
function excerptBody(body, maxLen = 80) {
  const trimmed = (body ?? '').trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

// The push-notification body line for a message: an excerpt for text,
// a fixed emoji label for media (never leaks a caption-less media body).
function pushBodyFor(message) {
  if (message.kind === 'image') return '📷 Photo';
  if (message.kind === 'video') return '🎥 Video';
  return excerptBody(message.body);
}

// Global default: generous enough that no legitimate user of this small
// self-hosted app ever notices it, but it caps how much CPU/IO an anonymous
// client can make any single route do per minute. Auth routes get their own
// much stricter per-route override (see routes/auth.js) since login/register
// are the routes worth brute-forcing.
const DEFAULT_RATE_LIMIT_MAX = 300;
const DEFAULT_RATE_LIMIT_WINDOW = '1 minute';

// Rate-limit key: prefer Cloudflare's CF-Connecting-IP (set by the edge this
// app is deployed behind per the README's hub-integration section — the
// *actual* client IP, since everything else arrives from Cloudflare's own
// proxy IP) and fall back to Fastify's own request.ip (accurate for a direct
// connection, and — with trustProxy enabled below — for any other
// X-Forwarded-For-style proxy in front of it too).
function rateLimitKey(request) {
  return request.headers['cf-connecting-ip'] || request.ip;
}

// Builds a fully configured Fastify instance. Does NOT call listen() — the
// caller (server entrypoint or a test's app.inject()) owns that.
//
// `logger` defaults to true (Fastify's own request/response/error logging)
// for the real server; tests pass `logger: false` to keep test output
// clean. `trustProxy: true` makes Fastify honor X-Forwarded-For (and
// populate request.ip from it) since this app is always meant to run behind
// a reverse proxy/edge (see README) — required for both the rate limiter's
// and any future IP-based logic's request.ip to reflect the real client
// rather than the proxy's own address.
export function buildApp({
  config,
  db,
  mediaDir,
  webDistDir = DEFAULT_WEB_DIST_DIR,
  logger = true,
  wsHeartbeatIntervalMs,
  wsMaxMissedPongs,
}) {
  const app = Fastify({ logger, trustProxy: true });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('mediaDir', mediaDir);
  app.decorateRequest('user', null);

  // ws.js/push.js are factories (not module-level singletons) so every
  // buildApp() call — including each test's own app — gets its own
  // connection registry instead of sharing process-wide state.
  const ws = createWs({ heartbeatIntervalMs: wsHeartbeatIntervalMs, maxMissedPongs: wsMaxMissedPongs });
  app.decorate('pushToUsers', ws.pushToUsers);
  app.decorate('hasOpenSocket', ws.hasOpenSocket);

  const push = createPush(config, db, ws.hasOpenSocket, app.log);
  app.decorate('sendPush', push.sendPush);

  // Called after a text or media message is inserted (both routes/
  // conversations.js and routes/media.js call this the same way). Notifies
  // every OTHER participant over WS immediately, then web-pushes anyone
  // among them without an open socket (sendPush itself skips anyone with
  // one, and is a safe no-op when VAPID isn't configured).
  //
  // `mentionIds` (participants @-tagged in the body) and `replyAuthorId`
  // (author of the message being replied to) get their own push title so a
  // phone shows "X nhắc đến bạn" / "X trả lời bạn" instead of a plain new-
  // message line; everyone else gets the generic one.
  app.decorate('notifyNewMessage', async (conversationId, message, { mentionIds = [], replyAuthorId = null } = {}) => {
    const recipientIds = db
      .prepare('SELECT user_id FROM participants WHERE conversation_id = ? AND user_id != ?')
      .all(conversationId, message.sender_id)
      .map((row) => row.user_id);
    if (recipientIds.length === 0) return;

    app.pushToUsers(recipientIds, { type: 'message:new', conversation_id: conversationId, message });

    const sender = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(message.sender_id);
    const senderName = sender?.display_name || sender?.username || 'Lazybutts';
    const body = pushBodyFor(message);
    const url = `/chat/${conversationId}`;
    const mentioned = new Set(mentionIds.filter((id) => recipientIds.includes(id)));
    const replied = replyAuthorId !== null && recipientIds.includes(replyAuthorId) && !mentioned.has(replyAuthorId)
      ? replyAuthorId
      : null;
    const others = recipientIds.filter((id) => !mentioned.has(id) && id !== replied);
    await Promise.all([
      mentioned.size > 0 && app.sendPush([...mentioned], { title: `📣 ${senderName} nhắc đến bạn`, body, url }),
      replied !== null && app.sendPush([replied], { title: `↩️ ${senderName} trả lời bạn`, body, url }),
      others.length > 0 && app.sendPush(others, { title: senderName, body, url }),
    ]);
  });

  // Called after a story is inserted. Broadcast-only over WS to every OTHER
  // user in the app (stories aren't scoped to a conversation) — no push,
  // per spec ("đỡ ồn" — keep it quiet).
  app.decorate('notifyNewStory', (posterId, storyId) => {
    const otherUserIds = db.prepare('SELECT id FROM users WHERE id != ?').all(posterId).map((row) => row.id);
    app.pushToUsers(otherUserIds, { type: 'story:new', user_id: posterId, story_id: storyId });
  });

  // Called after a brand-new conversation is created (not the dedupe path
  // that returns an existing 1-1 conversation). WS-only, to every
  // participant except the one who created it.
  app.decorate('notifyNewConversation', (conversation, creatorId) => {
    const otherIds = conversation.participants.filter((p) => p.id !== creatorId).map((p) => p.id);
    app.pushToUsers(otherIds, { type: 'conversation:new', conversation });
  });

  // Service-to-service endpoint for the farm game (Nông trại vui vẻ), which
  // lives behind the same public host (path /farm/*) but in its own
  // container: it authenticates its players by forwarding their lb_session
  // cookie to /api/me, and calls this route to web-push a player (e.g. "your
  // crops got stolen"). Guarded by a shared secret — the route only exists
  // when FARM_INTERNAL_SECRET is configured, and the caller must present the
  // same value.
  if (config.farmInternalSecret) {
    app.post('/internal/farm/notify', async (request, reply) => {
      if (request.headers['x-farm-secret'] !== config.farmInternalSecret) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { userIds, title, body, url } = request.body ?? {};
      if (!Array.isArray(userIds) || userIds.length === 0 || !title) {
        return reply.code(400).send({ error: 'bad_request' });
      }
      await app.sendPush(userIds.map(Number), {
        title: String(title),
        body: String(body ?? ''),
        url: typeof url === 'string' && url.startsWith('/') ? url : '/farm/',
      });
      return reply.send({ ok: true });
    });
  }

  // Security headers on every response (API, WS upgrade errors, and the
  // static SPA alike) — onSend runs for every reply regardless of which
  // handler/plugin produced it, including Fastify's own error/404 replies.
  // nosniff blocks a browser from MIME-sniffing an uploaded media file (see
  // media.js/routes/media.js) into something it treats as executable
  // (HTML/JS); no-referrer keeps chat URLs (which embed conversation/message
  // ids) out of any Referer header sent to a third party; frame-ancestors
  // 'none' stops this app from being framed by another site (clickjacking).
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    return payload;
  });

  // Global default (see DEFAULT_RATE_LIMIT_MAX's comment); /auth/login and
  // /auth/register override this with a much stricter limit (routes/auth.js).
  app.register(rateLimit, {
    max: DEFAULT_RATE_LIMIT_MAX,
    timeWindow: DEFAULT_RATE_LIMIT_WINDOW,
    keyGenerator: rateLimitKey,
  });

  app.register(cookie);
  // fileSize caps a single upload part at config.maxUploadBytes; exceeding it
  // makes @fastify/multipart throw a RequestFileTooLargeError (statusCode
  // 413 already attached), which routes leave uncaught so Fastify's default
  // error handler turns it straight into a 413 response.
  app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });

  // Must be registered before any other route (see ws.js's comment) and
  // after @fastify/cookie (the /ws route's auth reads request.cookies).
  // Registered at root, not under /api — matches how the spec's own bullet
  // list writes it plainly as "GET /ws", unlike every other route in that
  // list which the codebase places under /api.
  ws.registerWsRoute(app);

  app.register(
    async (api) => {
      await registerAuthRoutes(api);
      await registerMeRoutes(api);
      await registerUsersRoutes(api);
      await registerInviteRoutes(api);
      await registerGifRoutes(api);
      await registerStickerRoutes(api);
      await registerEmbedRoutes(api);
      await registerConversationRoutes(api);
      await registerMediaRoutes(api);
      await registerStoryRoutes(api);
      await registerPushRoutes(api);
    },
    { prefix: '/api' },
  );

  // Serves the built web app (web/dist) at "/" and falls back to
  // index.html for any other unmatched GET (client-side router paths like
  // /chat/3 or /settings) so a hard refresh/deep link works. Only wired up
  // when the dist dir actually exists — e.g. it's absent in most test runs,
  // and this keeps that a silent no-op rather than a startup failure.
  const indexHtmlPath = join(webDistDir, 'index.html');
  if (existsSync(indexHtmlPath)) {
    app.register(staticPlugin, { root: webDistDir });

    app.setNotFoundHandler((request, reply) => {
      // API and WS 404s must stay JSON — only fall back to the SPA shell for
      // plain-browser GET navigation. Fastify's default 404 handler (JSON,
      // matching statusCode/error/message) covers everything else: wrong
      // method on a real route, unknown /api/* route, etc.
      const isSpaNavigation =
        request.raw.method === 'GET' && !request.url.startsWith('/api') && request.url !== '/ws';
      if (isSpaNavigation) {
        return reply.type('text/html').send(createReadStream(indexHtmlPath));
      }
      reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
