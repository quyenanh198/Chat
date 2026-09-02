// Registers public/sw.js on load, and exposes a helper (used by the
// Settings screen in Task 7) that makes sure the current registration has a
// live push subscription, wiring it up against the server's VAPID public
// key if one doesn't exist yet.

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
      console.error('Service worker registration failed', err);
    });
  });
}

// Web push's applicationServerKey wants raw bytes, but VAPID public keys are
// handed out as URL-safe base64 — this is the standard conversion.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  // Explicit ArrayBuffer backing (rather than the default ArrayBufferLike)
  // so this satisfies PushSubscriptionOptionsInit.applicationServerKey's
  // BufferSource type under TS 5.7+'s generic TypedArray lib types.
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Minimal shape ensurePushSubscription needs from src/api.ts — passing the
// whole `api` module namespace in satisfies this structurally.
export interface PushApi {
  getVapidKey(): Promise<{ publicKey: string }>;
  subscribePush(subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }): Promise<unknown>;
}

// Endpoint of this browser's current push subscription, or null when it has
// none (never subscribed, or the subscription was dropped by the browser).
export async function currentPushEndpoint(): Promise<string | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    // `ready` never settles when no worker is registered (e.g. registration
    // failed) — cap the wait so callers can still render a status.
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (!registration) return null;
    const subscription = await registration.pushManager.getSubscription();
    return subscription?.endpoint ?? null;
  } catch {
    return null;
  }
}

// iOS Safari only delivers web push to sites installed on the Home Screen
// (iOS 16.4+); in the plain browser tab PushManager is simply absent.
export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

// Idempotent: reuses an existing subscription if the browser already has
// one, otherwise subscribes and tells the server about it. Returns null
// when push isn't supported at all (no serviceWorker/PushManager).
export async function ensurePushSubscription(api: PushApi): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return null;
  }

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    const { publicKey } = await api.getVapidKey();
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('push subscription missing endpoint/keys');
  }

  await api.subscribePush({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });

  return subscription;
}
