import { requireUser } from '../auth.js';

const GIPHY_URL = 'https://api.giphy.com/v1/gifs/search';

const GIPHY_STICKER_SEARCH = 'https://api.giphy.com/v1/stickers/search';
const GIPHY_STICKER_TRENDING = 'https://api.giphy.com/v1/stickers/trending';

export async function registerGifRoutes(app) {
  // Zalo-style meme/sticker picker: trending when no query, search otherwise.
  app.get('/gif/memes', { preHandler: requireUser }, async (request, reply) => {
    const key = app.config.giphyKey;
    if (!key) {
      return reply.code(503).send({ error: 'gif_disabled' });
    }
    const q = String(request.query?.q ?? '').slice(0, 100).trim();
    const url = q
      ? `${GIPHY_STICKER_SEARCH}?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13&lang=vi`
      : `${GIPHY_STICKER_TRENDING}?api_key=${encodeURIComponent(key)}&limit=24&rating=pg-13`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        return reply.code(502).send({ error: 'gif_upstream_error' });
      }
      const data = await res.json();
      const results = (data.data ?? [])
        .map((g) => ({
          id: g.id,
          preview: g.images?.fixed_width_small?.url ?? g.images?.fixed_width?.url,
          url: g.images?.original?.url ?? g.images?.fixed_width?.url,
        }))
        .filter((g) => g.preview && g.url);
      return reply.send({ results });
    } catch {
      return reply.code(502).send({ error: 'gif_upstream_error' });
    }
  });

  app.get('/gif/search', { preHandler: requireUser }, async (request, reply) => {
    const key = app.config.giphyKey;
    if (!key) {
      return reply.code(503).send({ error: 'gif_disabled' });
    }
    const q = String(request.query?.q ?? '').slice(0, 100).trim();
    if (!q) {
      return reply.code(400).send({ error: 'query_required' });
    }
    const url = `${GIPHY_URL}?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13&lang=vi`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        return reply.code(502).send({ error: 'gif_upstream_error' });
      }
      const data = await res.json();
      const results = (data.data ?? [])
        .map((g) => ({
          id: g.id,
          preview: g.images?.fixed_width_small?.url ?? g.images?.fixed_width?.url,
          url: g.images?.original?.url ?? g.images?.fixed_width?.url,
        }))
        .filter((g) => g.preview && g.url);
      return reply.send({ results });
    } catch {
      return reply.code(502).send({ error: 'gif_upstream_error' });
    }
  });
}
