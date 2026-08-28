import { requireUser } from '../auth.js';

export async function registerUsersRoutes(app) {
  app.get('/users', { preHandler: requireUser }, async (request, reply) => {
    const users = app.db
      .prepare('SELECT id, username FROM users WHERE id != ? ORDER BY username')
      .all(request.user.id);
    return reply.send(users);
  });
}
