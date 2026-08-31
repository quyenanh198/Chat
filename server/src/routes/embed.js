import { requireUser } from '../auth.js';

const ALLOWED_HOSTS = new Set(['giphy.com', 'www.giphy.com', 'tenor.com', 'www.tenor.com']);
const cache = new Map(); // pageUrl -> mediaUrl|null
const CACHE_MAX = 500;

// Resolves a giphy/tenor page link to its direct media URL via the page's
// og:image tag, so pasted share-links render inline like direct .gif URLs.
export async function registerEmbedRoutes(app) {
  app.get('/embed/resolve', { preHandler: requireUser }, async (request, reply) => {
    const raw = String(request.query?.url ?? '');
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return reply.code(400).send({ error: 'invalid_url' });
    }
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
      return reply.code(400).send({ error: 'unsupported_host' });
    }
    if (cache.has(raw)) {
      return reply.send({ url: cache.get(raw) });
    }
    let media = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(raw, {
        signal: controller.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; LazybuttsChat/1.0)' },
      });
      clearTimeout(timer);
      if (res.ok) {
        const html = (await res.text()).slice(0, 300_000);
        const m =
          /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/.exec(html) ||
          /<meta[^>]+content="([^"]+)"[^>]+property="og:image"/.exec(html);
        if (m && /^https:\/\//.test(m[1])) media = m[1];
      }
    } catch {
      /* resolve is best-effort */
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(raw, media);
    return reply.send({ url: media });
  });
}
