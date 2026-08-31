import { unlink } from 'node:fs/promises';

import { thumbPathFor } from './media.js';

const DEFAULT_INTERVAL_MS = 60_000;

// One cleanup pass: hard-deletes every message/story whose expires_at has
// already passed (unlinking its media_path file first, when present), then
// sweeps any media_views/story_views rows left pointing at a message/story
// id that no longer exists. That last step is belt-and-suspenders — the
// once-mode "everyone viewed" path in routes/media.js already deletes a
// message's media_views rows in the same transaction as the message
// itself — but it also catches anything this pass's own message/story
// deletes just orphaned, plus any other future path that isn't as careful.
//
// A best-effort unlink failure (file already gone, e.g. from a previous
// crashed run) is swallowed — the row is still removed from the db either
// way, since a missing file is not a reason to keep a dead row around.
export async function runCleanup(db, mediaDir) {
  const now = Date.now();

  const expiredMessages = db.prepare('SELECT id, media_path FROM messages WHERE expires_at <= ?').all(now);
  db.prepare('DELETE FROM messages WHERE expires_at <= ?').run(now);
  for (const { media_path } of expiredMessages) {
    if (media_path) {
      await unlink(media_path).catch(() => {});
      // Image messages may have a lazily generated preview sitting next to
      // the original (see media.js's ensureThumb) — sweep it along.
      await unlink(thumbPathFor(media_path)).catch(() => {});
    }
  }

  const expiredStories = db.prepare('SELECT id, media_path FROM stories WHERE expires_at <= ?').all(now);
  db.prepare('DELETE FROM stories WHERE expires_at <= ?').run(now);
  for (const { media_path } of expiredStories) {
    await unlink(media_path).catch(() => {});
  }

  db.prepare('DELETE FROM media_views WHERE message_id NOT IN (SELECT id FROM messages)').run();
  db.prepare('DELETE FROM story_views WHERE story_id NOT IN (SELECT id FROM stories)').run();
}

// Starts the periodic cleanup job (every intervalMs, default 60s per spec).
// The timer is unref()'d so it can never keep the Node process alive on its
// own — the server still exits promptly on SIGTERM/SIGINT even if nothing
// calls the returned stop() first. A pass that throws (e.g. a transient fs
// error) is logged and does not kill the interval — the next tick tries
// again. Returns stop(), which cancels the interval (tests, graceful
// shutdown).
export function startCleanup(db, mediaDir, intervalMs = DEFAULT_INTERVAL_MS) {
  const timer = setInterval(() => {
    runCleanup(db, mediaDir).catch((err) => {
      console.error('[cleanup] pass failed:', err);
    });
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
