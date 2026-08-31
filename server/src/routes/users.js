import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { requireUser } from '../auth.js';

export async function registerUsersRoutes(app) {
  app.get('/users', { preHandler: requireUser }, async (request, reply) => {
    const users = app.db
      .prepare('SELECT id, username, display_name, avatar_at FROM users WHERE id != ? ORDER BY username')
      .all(request.user.id);
    return reply.send(users);
  });

  app.get('/users/:id/avatar', { preHandler: requireUser }, async (request, reply) => {
    const uid = Number(request.params.id);
    if (!Number.isInteger(uid)) return reply.code(400).send({ error: 'invalid_id' });
    const dir = join(app.mediaDir, 'avatars');
    const names = await fsp.readdir(dir).catch(() => []);
    const name = names.find((n) => n.startsWith(`${uid}.`));
    if (!name) return reply.code(404).send({ error: 'no_avatar' });
    const ext = name.split('.').pop();
    const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const bytes = await fsp.readFile(join(dir, name));
    reply.header('cache-control', 'private, max-age=86400');
    return reply.type(type).send(bytes);
  });
}
