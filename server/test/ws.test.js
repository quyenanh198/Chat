import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeTestDb } from './helpers.js';

function extractSessionCookie(response) {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((c) => c.startsWith('lb_session='));
  return sessionCookie ? sessionCookie.split(';')[0] : null;
}

async function buildRunningApp(envOverrides = {}, appOverrides = {}) {
  const { db, mediaDir } = makeTestDb();
  const config = loadConfig({ SESSION_SECRET: 'test-secret', ...envOverrides });
  const app = buildApp({ config, db, mediaDir, logger: false, ...appOverrides });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}

function wsUrl(app) {
  const { port } = app.server.address();
  return `ws://127.0.0.1:${port}/ws`;
}

function registerUser(app, body) {
  return app.inject({ method: 'POST', url: '/api/auth/register', payload: body });
}

async function createInvite(app, adminCookie) {
  const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { cookie: adminCookie } });
  return res.json().code;
}

async function setupUsers(app, n) {
  const names = ['bob', 'carol', 'dave'];
  const aliceRes = await registerUser(app, { username: 'alice', password: 'password1234' });
  const alice = { id: aliceRes.json().user.id, cookie: extractSessionCookie(aliceRes) };

  const others = [];
  for (let i = 0; i < n; i++) {
    const code = await createInvite(app, alice.cookie);
    const res = await registerUser(app, { username: names[i], password: 'password1234', invite: code });
    others.push({ id: res.json().user.id, cookie: extractSessionCookie(res) });
  }

  return { alice, others };
}

// Connects a real ws client to the running app's /ws route, resolving with
// the open socket or rejecting with the HTTP upgrade's status code.
// `wsOptions` is merged into the underlying `ws` client's constructor
// options — e.g. `{ headers: { Origin: '...' } }` for the origin-check
// tests, or `{ autoPong: false }` for the heartbeat tests (so the client
// stops answering the server's pings, simulating a half-open connection).
function connectWs(app, cookie, wsOptions = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(wsOptions.headers ?? {}) };
    const socket = new WebSocket(wsUrl(app), { ...wsOptions, headers });
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (request, response) => {
      reject(Object.assign(new Error('unexpected response'), { statusCode: response.statusCode }));
    });
    socket.once('error', (err) => reject(err));
  });
}

function nextMessage(socket) {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

async function postStoryUpload(app, cookie) {
  const form = new FormData();
  form.set('file', new Blob([Buffer.alloc(16, 1)], { type: 'image/png' }), 'story.png');
  const request = new Request('http://localhost/upload', { method: 'POST', body: form });
  const payload = Buffer.from(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  headers.cookie = cookie;

  return app.inject({ method: 'POST', url: '/api/stories', headers, payload });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let runningApps = [];
let openSockets = [];

afterEach(async () => {
  for (const socket of openSockets) {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  }
  openSockets = [];
  await Promise.all(runningApps.map((app) => app.close()));
  runningApps = [];
});

async function trackedRunningApp(envOverrides, appOverrides) {
  const app = await buildRunningApp(envOverrides, appOverrides);
  runningApps.push(app);
  return app;
}

async function trackedConnect(app, cookie, wsOptions) {
  const socket = await connectWs(app, cookie, wsOptions);
  openSockets.push(socket);
  return socket;
}

describe('GET /ws', () => {
  it('rejects the upgrade with 401 when there is no valid session cookie', async () => {
    const app = await trackedRunningApp();

    await expect(connectWs(app, null)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('delivers message:new to another participant with an open socket when a text message is sent via REST', async () => {
    const app = await trackedRunningApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;

    const convRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: alice.cookie },
      payload: { user_ids: [bob.id] },
    });
    const conversationId = convRes.json().conversation.id;

    const bobSocket = await trackedConnect(app, bob.cookie);
    const received = nextMessage(bobSocket);

    const sendRes = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: alice.cookie },
      payload: { body: 'hello bob' },
    });
    expect(sendRes.statusCode).toBe(201);

    const event = await received;
    expect(event.type).toBe('message:new');
    expect(event.conversation_id).toBe(conversationId);
    expect(event.message.body).toBe('hello bob');
    expect(event.message.sender_id).toBe(alice.id);
  });

  it('does not deliver message:new back to the sender itself', async () => {
    const app = await trackedRunningApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;

    const convRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: alice.cookie },
      payload: { user_ids: [bob.id] },
    });
    const conversationId = convRes.json().conversation.id;

    const aliceSocket = await trackedConnect(app, alice.cookie);
    let gotEvent = false;
    aliceSocket.on('message', () => {
      gotEvent = true;
    });

    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: alice.cookie },
      payload: { body: 'hi' },
    });
    await sleep(50);

    expect(gotEvent).toBe(false);
  });

  it('delivers message:new to every other group participant', async () => {
    const app = await trackedRunningApp();
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;

    const convRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: alice.cookie },
      payload: { user_ids: [bob.id, carol.id], name: 'Group' },
    });
    const conversationId = convRes.json().conversation.id;

    const bobSocket = await trackedConnect(app, bob.cookie);
    const carolSocket = await trackedConnect(app, carol.cookie);
    const bobEvent = nextMessage(bobSocket);
    const carolEvent = nextMessage(carolSocket);

    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: alice.cookie },
      payload: { body: 'hi group' },
    });

    const [bobGot, carolGot] = await Promise.all([bobEvent, carolEvent]);
    expect(bobGot.type).toBe('message:new');
    expect(carolGot.type).toBe('message:new');
  });

  it('sends conversation:new to the other participant on a freshly created conversation, not on the 1-1 dedupe path', async () => {
    const app = await trackedRunningApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;

    const bobSocket = await trackedConnect(app, bob.cookie);
    const bobEvent = nextMessage(bobSocket);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: alice.cookie },
      payload: { user_ids: [bob.id] },
    });
    expect(createRes.statusCode).toBe(201);
    const conversationId = createRes.json().conversation.id;

    const event = await bobEvent;
    expect(event.type).toBe('conversation:new');
    expect(event.conversation.id).toBe(conversationId);

    // Second POST for the same pair dedupes to the existing conversation
    // (200, not 201) and must NOT fire a second conversation:new.
    let gotSecondEvent = false;
    bobSocket.on('message', () => {
      gotSecondEvent = true;
    });
    const dedupeRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: alice.cookie },
      payload: { user_ids: [bob.id] },
    });
    expect(dedupeRes.statusCode).toBe(200);
    await sleep(50);
    expect(gotSecondEvent).toBe(false);
  });

  it('broadcasts story:new to every other connected user but not back to the poster', async () => {
    const app = await trackedRunningApp();
    const { alice, others } = await setupUsers(app, 2);
    const [bob, carol] = others;

    const bobSocket = await trackedConnect(app, bob.cookie); // poster
    const aliceSocket = await trackedConnect(app, alice.cookie);
    const carolSocket = await trackedConnect(app, carol.cookie);

    const aliceEvent = nextMessage(aliceSocket);
    const carolEvent = nextMessage(carolSocket);
    let bobGotEvent = false;
    bobSocket.on('message', () => {
      bobGotEvent = true;
    });

    const res = await postStoryUpload(app, bob.cookie);
    expect(res.statusCode).toBe(201);
    const story = res.json();

    const [aliceGot, carolGot] = await Promise.all([aliceEvent, carolEvent]);
    expect(aliceGot).toEqual({ type: 'story:new', user_id: bob.id, story_id: story.id });
    expect(carolGot).toEqual({ type: 'story:new', user_id: bob.id, story_id: story.id });

    await sleep(50);
    expect(bobGotEvent).toBe(false);
  });
});

// I2: a cross-site page trying to ride a victim's session cookie into /ws
// sends its own Origin header, which won't match our Host. A non-browser
// client (curl, a mobile app, or — as it happens — every other test in this
// file's own `ws` client) sends no Origin at all and must still get in.
describe('GET /ws — origin check', () => {
  it('rejects the upgrade with 403 when Origin names a different host', async () => {
    const app = await trackedRunningApp();
    const { alice } = await setupUsers(app, 0);

    await expect(
      connectWs(app, alice.cookie, { headers: { Origin: 'https://evil.example' } }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('accepts the upgrade when Origin matches the request Host (same-origin)', async () => {
    const app = await trackedRunningApp();
    const { alice } = await setupUsers(app, 0);
    const { port } = app.server.address();

    const socket = await trackedConnect(app, alice.cookie, { headers: { Origin: `http://127.0.0.1:${port}` } });

    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('accepts the upgrade when Origin is absent entirely (non-browser client)', async () => {
    const app = await trackedRunningApp();
    const { alice } = await setupUsers(app, 0);

    const socket = await trackedConnect(app, alice.cookie);

    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});

// M3: the server pings every open connection on an interval and terminates
// one that stops answering. Both tests override the interval down to a few
// milliseconds (via buildApp's wsHeartbeatIntervalMs/wsMaxMissedPongs test
// hooks — see ws.js) so this doesn't have to wait out the real 30s cadence.
describe('GET /ws — heartbeat', () => {
  it('terminates a socket that stops answering pings and cleans up the connection registry', async () => {
    const app = await trackedRunningApp({}, { wsHeartbeatIntervalMs: 20, wsMaxMissedPongs: 2 });
    const { others } = await setupUsers(app, 1);
    const [bob] = others;

    // autoPong: false — this client will never answer the server's pings,
    // simulating a half-open connection (e.g. a phone that dropped off wifi
    // without a clean TCP close).
    const bobSocket = await trackedConnect(app, bob.cookie, { autoPong: false });
    const closed = new Promise((resolve) => bobSocket.once('close', resolve));

    await closed;

    // Registry cleanup actually ran: push.js's hasOpenSocket must stop
    // reporting bob as reachable once his dead connection is gone.
    expect(app.hasOpenSocket(bob.id)).toBe(false);
  });

  it('leaves a socket that keeps answering pings (the ws client auto-pongs by default) open', async () => {
    const app = await trackedRunningApp({}, { wsHeartbeatIntervalMs: 20, wsMaxMissedPongs: 2 });
    const { others } = await setupUsers(app, 1);
    const [bob] = others;

    const bobSocket = await trackedConnect(app, bob.cookie);

    await sleep(150); // several heartbeat ticks' worth

    expect(bobSocket.readyState).toBe(WebSocket.OPEN);
    expect(app.hasOpenSocket(bob.id)).toBe(true);
  });
});
