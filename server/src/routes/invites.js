import { randomBytes } from 'node:crypto';
import { requireUser } from '../auth.js';

export async function registerInviteRoutes(app) {
  app.post('/invites', { preHandler: requireUser }, async (request, reply) => {
    if (!request.user.is_admin) {
      return reply.code(403).send({ error: 'admin_required' });
    }

    const code = randomBytes(4).toString('hex'); // 8 hex chars, single-use
    const now = Date.now();
    app.db
      .prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)')
      .run(code, request.user.id, now);

    return reply.code(201).send({ code });
  });
}
