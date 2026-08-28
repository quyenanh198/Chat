// Fetches a binary media endpoint (GET /api/media/:messageId or
// GET /api/stories/:id/media) as an object URL. These routes stream raw
// bytes (image/video), not JSON, so they can't go through api.ts's
// request() helper — but they still need the same credentials + error
// handling (a JSON {error: "..."} body on non-2xx, e.g. 403 already_viewed).
import { ApiError } from './api';

export async function fetchMediaBlobUrl(path: string): Promise<string> {
  const res = await fetch(path, { credentials: 'include' });

  if (!res.ok) {
    let body: { error?: string } = {};
    try {
      body = (await res.json()) as { error?: string };
    } catch {
      // non-JSON error body (e.g. a raw 413); fall through to statusText
    }
    throw new ApiError(body.error ?? res.statusText, res.status, body);
  }

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
