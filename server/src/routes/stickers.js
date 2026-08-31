import { createWriteStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { requireUser } from '../auth.js';

const STICKER_TYPES = new Map([
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/jpeg', 'jpg'],
]);

// Family sticker pack: anyone can add, everyone sees them, the uploader
// (or an admin) can delete. Files live in <media>/stickers/<id>.<ext>.
export async function registerStickerRoutes(app) {
  const dir = () => join(app.mediaDir, 'stickers');

  app.get('/stickers', { preHandler: requireUser }, async (request, reply) => {
    const rows = app.db
      .prepare('SELECT id, uploader_id, ext FROM custom_stickers ORDER BY created_at DESC')
      .all();
    return reply.send({
      results: rows.map((r) => ({
        id: r.id,
        url: `/api/stickers/img/${r.id}.${r.ext}`,
        mine: r.uploader_id === request.user.id || !!request.user.is_admin,
      })),
    });
  });

  app.post('/stickers', { preHandler: requireUser }, async (request, reply) => {
    const part = await request.file();
    const ext = part && STICKER_TYPES.get(part.mimetype);
    if (!ext) {
      return reply.code(400).send({ error: 'invalid_sticker_type' });
    }
    await fsp.mkdir(dir(), { recursive: true });
    const info = app.db
      .prepare('INSERT INTO custom_stickers (uploader_id, ext, created_at) VALUES (?, ?, ?)')
      .run(request.user.id, ext, Date.now());
    const id = info.lastInsertRowid;
    const path = join(dir(), `${id}.${ext}`);
    await pipeline(part.file, createWriteStream(path));
    if (part.file.truncated) {
      await fsp.unlink(path).catch(() => {});
      app.db.prepare('DELETE FROM custom_stickers WHERE id = ?').run(id);
      return reply.code(413).send({ error: 'sticker_too_large' });
    }
    return reply.code(201).send({ id, url: `/api/stickers/img/${id}.${ext}`, mine: true });
  });

  app.delete('/stickers/:id', { preHandler: requireUser }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    const row = app.db.prepare('SELECT uploader_id, ext FROM custom_stickers WHERE id = ?').get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.uploader_id !== request.user.id && !request.user.is_admin) {
      return reply.code(403).send({ error: 'not_yours' });
    }
    app.db.prepare('DELETE FROM custom_stickers WHERE id = ?').run(id);
    await fsp.unlink(join(dir(), `${id}.${row.ext}`)).catch(() => {});
    return reply.send({ ok: true });
  });

  app.get('/stickers/img/:file', { preHandler: requireUser }, async (request, reply) => {
    const m = /^(\d+)\.(png|gif|webp|jpg)$/.exec(String(request.params.file));
    if (!m) return reply.code(400).send({ error: 'invalid_file' });
    const bytes = await fsp.readFile(join(dir(), m[0])).catch(() => null);
    if (!bytes) return reply.code(404).send({ error: 'not_found' });
    const type = m[2] === 'jpg' ? 'image/jpeg' : `image/${m[2]}`;
    reply.header('cache-control', 'private, max-age=604800');
    return reply.type(type).send(bytes);
  });
}
