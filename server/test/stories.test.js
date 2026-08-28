import { describe, it, expect } from 'vitest';
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

function buildTestApp(envOverrides = {}) {
  const { db, mediaDir } = makeTestDb();
  const config = loadConfig({ SESSION_SECRET: 'test-secret', ...envOverrides });
  return buildApp({ config, db, mediaDir, logger: false });
}

function registerUser(app, body) {
  return app.inject({ method: 'POST', url: '/api/auth/register', payload: body });
}

async function createInvite(app, adminCookie) {
  const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { cookie: adminCookie } });
  return res.json().code;
}

async function setupUsers(app, n) {
  const names = ['bob', 'carol', 'dave', 'erin'];
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

async function postStory(app, cookie, { filename = 'story.png', mimetype = 'image/png', buffer }) {
  const form = new FormData();
  form.set('file', new Blob([buffer], { type: mimetype }), filename);
  const request = new Request('http://localhost/upload', { method: 'POST', body: form });
  const payload = Buffer.from(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  headers.cookie = cookie;

  return app.inject({ method: 'POST', url: '/api/stories', headers, payload });
}

function listStories(app, cookie) {
  return app.inject({ method: 'GET', url: '/api/stories', headers: { cookie } });
}

function getStoryMedia(app, cookie, storyId) {
  return app.inject({ method: 'GET', url: `/api/stories/${storyId}/media`, headers: { cookie } });
}

const FAKE_PNG = Buffer.alloc(1024, 0xcd);

describe('POST /api/stories', () => {
  it('creates a story that expires 24h from now', async () => {
    const app = buildTestApp();
    const { alice } = await setupUsers(app, 0);

    const before = Date.now();
    const res = await postStory(app, alice.cookie, { buffer: FAKE_PNG });
    const after = Date.now();

    expect(res.statusCode).toBe(201);
    const story = res.json();
    expect(story.kind).toBe('image');
    expect(story.user_id).toBe(alice.id);
    expect(story.expires_at - story.created_at).toBe(24 * 60 * 60 * 1000);
    expect(story.created_at).toBeGreaterThanOrEqual(before);
    expect(story.created_at).toBeLessThanOrEqual(after);
  });

  it('tags a video/* upload as kind video', async () => {
    const app = buildTestApp();
    const { alice } = await setupUsers(app, 0);

    const res = await postStory(app, alice.cookie, { filename: 'clip.mp4', mimetype: 'video/mp4', buffer: FAKE_PNG });

    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('video');
  });

  it('rejects an unsupported mimetype with 415', async () => {
    const app = buildTestApp();
    const { alice } = await setupUsers(app, 0);

    const res = await postStory(app, alice.cookie, {
      filename: 'notes.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('hello'),
    });

    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('unsupported_media_type');
  });

  it('returns 401 without a session cookie', async () => {
    const app = buildTestApp();

    const res = await postStory(app, '', { buffer: FAKE_PNG });

    expect(res.statusCode).toBe(401);
  });

  it('rejects an upload over config.maxUploadBytes with fastify 413', async () => {
    const app = buildTestApp({ MAX_UPLOAD_MB: '0.001' }); // ~1048 bytes cap
    const { alice } = await setupUsers(app, 0);

    const res = await postStory(app, alice.cookie, { buffer: Buffer.alloc(10_000, 1) });

    expect(res.statusCode).toBe(413);
  });
});

describe('GET /api/stories', () => {
  it('groups stories by user (including the caller own), with a viewed flag that flips after viewing', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;

    const aliceStory = (await postStory(app, alice.cookie, { buffer: FAKE_PNG })).json();
    const bobStory = (await postStory(app, bob.cookie, { buffer: FAKE_PNG })).json();

    const before = (await listStories(app, bob.cookie)).json();
    const beforeAliceGroup = before.find((g) => g.user.id === alice.id);
    const beforeBobGroup = before.find((g) => g.user.id === bob.id);
    expect(beforeAliceGroup.stories.find((s) => s.id === aliceStory.id).viewed).toBe(false);
    expect(beforeBobGroup.user.username).toBe('bob');

    // Bob views alice's story.
    const viewRes = await getStoryMedia(app, bob.cookie, aliceStory.id);
    expect(viewRes.statusCode).toBe(200);
    expect(viewRes.rawPayload.equals(FAKE_PNG)).toBe(true);

    const after = (await listStories(app, bob.cookie)).json();
    const afterAliceGroup = after.find((g) => g.user.id === alice.id);
    expect(afterAliceGroup.stories.find((s) => s.id === aliceStory.id).viewed).toBe(true);

    // Untouched for alice's own perspective — bob's story still unviewed by her.
    const aliceView = (await listStories(app, alice.cookie)).json();
    const aliceViewOfBob = aliceView.find((g) => g.user.id === bob.id);
    expect(aliceViewOfBob.stories.find((s) => s.id === bobStory.id).viewed).toBe(false);
  });

  it('excludes an expired story', async () => {
    const app = buildTestApp();
    const { alice } = await setupUsers(app, 0);
    const story = (await postStory(app, alice.cookie, { buffer: FAKE_PNG })).json();
    app.db.prepare('UPDATE stories SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, story.id);

    const res = await listStories(app, alice.cookie);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });

  it('returns 401 without a session cookie', async () => {
    const app = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/stories' });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/stories/:id/media', () => {
  it('allows repeat views by the same user', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const story = (await postStory(app, alice.cookie, { buffer: FAKE_PNG })).json();

    const first = await getStoryMedia(app, bob.cookie, story.id);
    const second = await getStoryMedia(app, bob.cookie, story.id);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const viewCount = app.db
      .prepare('SELECT COUNT(*) AS c FROM story_views WHERE story_id = ? AND user_id = ?')
      .get(story.id, bob.id).c;
    expect(viewCount).toBe(1);
  });

  it('is viewable by any logged-in user, not just conversation members', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 2);
    const [, carol] = others;
    const story = (await postStory(app, alice.cookie, { buffer: FAKE_PNG })).json();

    const res = await getStoryMedia(app, carol.cookie, story.id);

    expect(res.statusCode).toBe(200);
  });

  it('returns 404 once expired', async () => {
    const app = buildTestApp();
    const { alice, others } = await setupUsers(app, 1);
    const [bob] = others;
    const story = (await postStory(app, alice.cookie, { buffer: FAKE_PNG })).json();
    app.db.prepare('UPDATE stories SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, story.id);

    const res = await getStoryMedia(app, bob.cookie, story.id);

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an unknown story id', async () => {
    const app = buildTestApp();
    const { alice } = await setupUsers(app, 0);

    const res = await getStoryMedia(app, alice.cookie, 999999);

    expect(res.statusCode).toBe(404);
  });
});
