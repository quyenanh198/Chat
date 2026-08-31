import { requireUser, serializeUser } from '../auth.js';

const VALID_MEDIA_MODES = ['once', '24h'];

export async function registerMeRoutes(app) {
  app.get('/me', { preHandler: requireUser }, async (request, reply) => {
    return reply.send(request.user);
  });

  app.patch('/me/profile', { preHandler: requireUser }, async (request, reply) => {
    let { display_name } = request.body ?? {};
    if (typeof display_name !== 'string') {
      return reply.code(400).send({ error: 'invalid_display_name' });
    }
    display_name = display_name.trim();
    if (display_name.length > 40) {
      return reply.code(400).send({ error: 'display_name_too_long' });
    }
    app.db
      .prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .run(display_name || null, request.user.id);
    const user = app.db
      .prepare('SELECT id, username, display_name, is_admin, media_mode FROM users WHERE id = ?')
      .get(request.user.id);
    return reply.send({ user: serializeUser(user) });
  });

  app.patch('/me/settings', { preHandler: requireUser }, async (request, reply) => {
    const { media_mode } = request.body ?? {};
    if (!VALID_MEDIA_MODES.includes(media_mode)) {
      return reply.code(400).send({ error: 'invalid_media_mode' });
    }

    app.db.prepare('UPDATE users SET media_mode = ? WHERE id = ?').run(media_mode, request.user.id);
    const user = app.db
      .prepare('SELECT id, username, display_name, is_admin, media_mode FROM users WHERE id = ?')
      .get(request.user.id);

    return reply.send({ user: serializeUser(user) });
  });
}
