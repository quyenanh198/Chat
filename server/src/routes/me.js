import { createWriteStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { requireUser, serializeUser } from '../auth.js';

const AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const VALID_MEDIA_MODES = ['once', '24h'];

export async function registerMeRoutes(app) {
  app.get('/me', { preHandler: requireUser }, async (request, reply) => {
    return reply.send(request.user);
  });

  // Avatar: one file per user under <media>/avatars/<id>, content-type
  // remembered via users.avatar_at + a sibling .meta file-free approach:
  // we store the raw bytes and always serve as the uploaded mime (kept in
  // the filename extension).
  app.post('/me/avatar', { preHandler: requireUser }, async (request, reply) => {
    const part = await request.file();
    if (!part || !AVATAR_TYPES.has(part.mimetype)) {
      return reply.code(400).send({ error: 'invalid_avatar_type' });
    }
    const dir = join(app.mediaDir, 'avatars');
    await fsp.mkdir(dir, { recursive: true });
    const ext = part.mimetype.split('/')[1].replace('jpeg', 'jpg');
    // Remove any previous avatar with a different extension.
    for (const old of await fsp.readdir(dir).catch(() => [])) {
      if (old.startsWith(`${request.user.id}.`)) await fsp.unlink(join(dir, old)).catch(() => {});
    }
    await pipeline(part.file, createWriteStream(join(dir, `${request.user.id}.${ext}`)));
    if (part.file.truncated) {
      await fsp.unlink(join(dir, `${request.user.id}.${ext}`)).catch(() => {});
      return reply.code(413).send({ error: 'avatar_too_large' });
    }
    const now = Date.now();
    app.db.prepare('UPDATE users SET avatar_at = ? WHERE id = ?').run(now, request.user.id);
    const user = app.db
      .prepare('SELECT id, username, display_name, avatar_at, is_admin, media_mode, farm_notify FROM users WHERE id = ?')
      .get(request.user.id);
    return reply.send({ user: serializeUser(user) });
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
      .prepare('SELECT id, username, display_name, avatar_at, is_admin, media_mode, farm_notify FROM users WHERE id = ?')
      .get(request.user.id);
    return reply.send({ user: serializeUser(user) });
  });

  app.patch('/me/settings', { preHandler: requireUser }, async (request, reply) => {
    const { media_mode, farm_notify } = request.body ?? {};
    if (media_mode === undefined && farm_notify === undefined) {
      return reply.code(400).send({ error: 'invalid_media_mode' });
    }
    if (media_mode !== undefined && !VALID_MEDIA_MODES.includes(media_mode)) {
      return reply.code(400).send({ error: 'invalid_media_mode' });
    }
    if (farm_notify !== undefined && typeof farm_notify !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_farm_notify' });
    }

    if (media_mode !== undefined) {
      app.db.prepare('UPDATE users SET media_mode = ? WHERE id = ?').run(media_mode, request.user.id);
    }
    if (farm_notify !== undefined) {
      app.db.prepare('UPDATE users SET farm_notify = ? WHERE id = ?').run(farm_notify ? 1 : 0, request.user.id);
    }
    const user = app.db
      .prepare('SELECT id, username, display_name, avatar_at, is_admin, media_mode, farm_notify FROM users WHERE id = ?')
      .get(request.user.id);

    return reply.send({ user: serializeUser(user) });
  });
}
