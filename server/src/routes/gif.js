import { requireUser } from '../auth.js';

const TENOR_URL = 'https://tenor.googleapis.com/v2/search';

export async function registerGifRoutes(app) {
  app.get('/gif/search', { preHandler: requireUser }, async (request, reply) => {
    const key = app.config.tenorKey;
    if (!key) {
      return reply.code(503).send({ error: 'gif_disabled' });
    }
    const q = String(request.query?.q ?? '').slice(0, 100).trim();
    if (!q) {
      return reply.code(400).send({ error: 'query_required' });
    }
    const url = `${TENOR_URL}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=24&media_filter=gif,tinygif&contentfilter=medium`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        return reply.code(502).send({ error: 'gif_upstream_error' });
      }
      const data = await res.json();
      const results = (data.results ?? [])
        .map((r) => ({
          id: r.id,
          preview: r.media_formats?.tinygif?.url ?? r.media_formats?.gif?.url,
          url: r.media_formats?.gif?.url ?? r.media_formats?.tinygif?.url,
        }))
        .filter((r) => r.preview && r.url);
      return reply.send({ results });
    } catch {
      return reply.code(502).send({ error: 'gif_upstream_error' });
    }
  });
}
