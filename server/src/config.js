const DEFAULT_PORT = 8082;
const DEFAULT_DATA_DIR = '/data';
const DEFAULT_MAX_UPLOAD_MB = 50;
const BYTES_PER_MB = 1024 * 1024;

// Builds the app config from an env-like object (defaults to process.env).
// Throws if SESSION_SECRET is missing since sessions cannot be signed without it.
export function loadConfig(env = process.env) {
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET is required');
  }

  const port = env.PORT ? Number(env.PORT) : DEFAULT_PORT;
  const dataDir = env.DATA_DIR || DEFAULT_DATA_DIR;
  const maxUploadMb = env.MAX_UPLOAD_MB ? Number(env.MAX_UPLOAD_MB) : DEFAULT_MAX_UPLOAD_MB;
  const maxUploadBytes = maxUploadMb * BYTES_PER_MB;

  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
  const vapid =
    VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT
      ? { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT }
      : null;

  // Optional first-admin gate: when set, registering the very first user
  // (the one who becomes admin with no invite otherwise) additionally
  // requires `invite` to equal this value. Closes the window where anyone
  // who reaches the app before the real admin does gets to register the
  // admin account. Leave unset to keep the original "first register wins"
  // behavior (fine when the admin registers before exposing the app).
  const bootstrapInvite = env.BOOTSTRAP_INVITE || null;

  return { port, dataDir, sessionSecret, vapid, maxUploadBytes, bootstrapInvite };
}
