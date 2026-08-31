import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';

// Image extensions we downscale into a webp thumbnail for the in-bubble
// preview. GIFs are excluded on purpose (a static thumb would kill the
// animation) and HEIC because sharp's prebuilt binaries can't decode it —
// both fall back to serving the original.
const THUMBABLE_EXTS = new Set(['.jpg', '.png', '.webp']);
const THUMB_SUFFIX = '.thumb.webp';
const THUMB_MAX_DIM = 520;

export function thumbPathFor(mediaPath) {
  return `${mediaPath}${THUMB_SUFFIX}`;
}

// Returns the path of a downscaled webp thumbnail for `mediaPath`, creating
// it on first use (lazy — old messages get thumbs the first time someone
// scrolls past them). Returns null when the format isn't thumbable or sharp
// fails; callers then serve the original file instead.
export async function ensureThumb(mediaPath) {
  if (!THUMBABLE_EXTS.has(extname(mediaPath).toLowerCase())) return null;
  const thumbPath = thumbPathFor(mediaPath);
  try {
    await access(thumbPath);
    return thumbPath;
  } catch {
    // not generated yet — fall through and build it
  }
  try {
    await sharp(mediaPath)
      .rotate() // honor EXIF orientation (phone photos)
      .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toFile(thumbPath);
    return thumbPath;
  } catch {
    return null;
  }
}

// Mimetype -> file extension used when saving an upload to disk.
const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

// Reverse of EXT_BY_MIME (plus nothing extra) — used to set the Content-Type
// header when a route streams a saved file back out.
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]));

// Thrown by saveUpload when the part's mimetype is neither image/* nor
// video/*. Routes catch this and reply 415.
export class UnsupportedMediaTypeError extends Error {}

function kindForMime(mimetype) {
  if (mimetype?.startsWith('image/')) return 'image';
  if (mimetype?.startsWith('video/')) return 'video';
  return null;
}

// Falls back to a sanitized subtype (e.g. "video/x-msvideo" -> ".xmsvideo")
// for a supported kind whose exact mimetype isn't in EXT_BY_MIME.
function extForMime(mimetype) {
  if (EXT_BY_MIME[mimetype]) return EXT_BY_MIME[mimetype];
  const subtype = mimetype.split('/')[1] || 'bin';
  const cleaned = subtype.replace(/[^a-z0-9]/gi, '').slice(0, 10);
  return `.${cleaned || 'bin'}`;
}

// Content-Type to serve a saved file back with, inferred from the extension
// saveUpload gave it. Falls back to a generic binary type.
export function mimeForPath(path) {
  return MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream';
}

// Reads a multipart file part fully into memory, validates its mimetype is
// image/* or video/* (kind), and writes it to <mediaDir>/<uuid><ext>.
// Returns {path, kind}. Throws UnsupportedMediaTypeError for any other
// mimetype — the part is still fully drained via toBuffer() first so
// @fastify/multipart's parser doesn't stall waiting for a consumer.
export async function saveUpload(part, mediaDir) {
  const buffer = await part.toBuffer();
  const kind = kindForMime(part.mimetype);
  if (!kind) {
    throw new UnsupportedMediaTypeError(part.mimetype);
  }

  const filename = `${randomUUID()}${extForMime(part.mimetype)}`;
  const path = join(mediaDir, filename);
  await writeFile(path, buffer);

  return { path, kind };
}
