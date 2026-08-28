import { createReadStream, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMeRoutes } from './routes/me.js';
import { registerUsersRoutes } from './routes/users.js';
import { registerInviteRoutes } from './routes/invites.js';
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

// Builds a fully configured Fastify instance. Does NOT call listen() — the
// caller (server entrypoint or a test's app.inject()) owns that.
export function buildApp({ config, db, mediaDir, webDistDir = DEFAULT_WEB_DIST_DIR }) {
  const app = Fastify({ logger: false });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('mediaDir', mediaDir);
  app.decorateRequest('user', null);

  // ws.js/push.js are factories (not module-level singletons) so every
  // buildApp() call — including each test's own app — gets its own
  // connection registry instead of sharing process-wide state.
  const ws = createWs();
  app.decorate('pushToUsers', ws.pushToUsers);
  app.decorate('hasOpenSocket', ws.hasOpenSocket);

  const push = createPush(config, db, ws.hasOpenSocket, app.log);
  app.decorate('sendPush', push.sendPush);

  // Called after a text or media message is inserted (both routes/
  // conversations.js and routes/media.js call this the same way). Notifies
  // every OTHER participant over WS immediately, then web-pushes anyone
  // among them without an open socket (sendPush itself skips anyone with
  // one, and is a safe no-op when VAPID isn't configured).
  app.decorate('notifyNewMessage', async (conversationId, message) => {
    const recipientIds = db
      .prepare('SELECT user_id FROM participants WHERE conversation_id = ? AND user_id != ?')
      .all(conversationId, message.sender_id)
      .map((row) => row.user_id);
    if (recipientIds.length === 0) return;

    app.pushToUsers(recipientIds, { type: 'message:new', conversation_id: conversationId, message });

    const sender = db.prepare('SELECT username FROM users WHERE id = ?').get(message.sender_id);
    await app.sendPush(recipientIds, {
      title: sender?.username ?? 'Lazybutts',
      body: pushBodyFor(message),
      url: `/chat/${conversationId}`,
    });
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
