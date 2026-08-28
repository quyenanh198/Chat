import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMeRoutes } from './routes/me.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerConversationRoutes } from './routes/conversations.js';

// Builds a fully configured Fastify instance. Does NOT call listen() — the
// caller (server entrypoint or a test's app.inject()) owns that.
export function buildApp({ config, db, mediaDir }) {
  const app = Fastify({ logger: false });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('mediaDir', mediaDir);
  app.decorateRequest('user', null);
  // No-op default; Task 5 overrides this (by reassigning app.notifyNewMessage
  // on this root instance) to push new messages over WS/web-push. Decorated
  // on the root here — not inside the /api-prefixed child scope — so a
  // reassignment on the object returned from buildApp() is visible to the
  // route handlers below, which read it through the prototype chain.
  app.decorate('notifyNewMessage', async () => {});

  app.register(cookie);

  app.register(
    async (api) => {
      await registerAuthRoutes(api);
      await registerMeRoutes(api);
      await registerInviteRoutes(api);
      await registerConversationRoutes(api);
    },
    { prefix: '/api' },
  );

  return app;
}
