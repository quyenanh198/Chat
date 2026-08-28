import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMeRoutes } from './routes/me.js';
import { registerInviteRoutes } from './routes/invites.js';

// Builds a fully configured Fastify instance. Does NOT call listen() — the
// caller (server entrypoint or a test's app.inject()) owns that.
export function buildApp({ config, db, mediaDir }) {
  const app = Fastify({ logger: false });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('mediaDir', mediaDir);
  app.decorateRequest('user', null);

  app.register(cookie);

  app.register(
    async (api) => {
      await registerAuthRoutes(api);
      await registerMeRoutes(api);
      await registerInviteRoutes(api);
    },
    { prefix: '/api' },
  );

  return app;
}
