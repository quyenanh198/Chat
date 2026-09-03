import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeTestDb } from './helpers.js';

// Pulls the `lb_session=...` cookie (name=value only, no attributes) out of a
// fastify.inject() response so it can be replayed on the next request.
function extractSessionCookie(response) {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((c) => c.startsWith('lb_session='));
  return sessionCookie ? sessionCookie.split(';')[0] : null;
}

function buildTestApp() {
  const { db, mediaDir } = makeTestDb();
  const config = loadConfig({ SESSION_SECRET: 'test-secret' });
  return buildApp({ config, db, mediaDir, logger: false });
}

function registerUser(app, body) {
  return app.inject({ method: 'POST', url: '/api/auth/register', payload: body });
}

async function createInvite(app, adminCookie) {
  const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { cookie: adminCookie } });
  return res.json().code;
}

// alice is the admin (first user, no invite needed); bob, carol, dave, erin
// each join via a fresh invite code.
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

function inject(app, cookie, method, url, payload) {
  return app.inject({ method, url, headers: { cookie }, payload });
}

const createConversation = (app, cookie, payload) => inject(app, cookie, 'POST', '/api/conversations', payload);
const listConversations = (app, cookie) => inject(app, cookie, 'GET', '/api/conversations');
const getMessages = (app, cookie, id) => inject(app, cookie, 'GET', `/api/conversations/${id}/messages`);
const sendText = (app, cookie, id, body) => inject(app, cookie, 'POST', `/api/conversations/${id}/messages`, { body });
const getMembers = (app, cookie, id) => inject(app, cookie, 'GET', `/api/conversations/${id}/members`);
const addMember = (app, cookie, id, userId) => inject(app, cookie, 'POST', `/api/conversations/${id}/members`, { userId });
const removeMember = (app, cookie, id, userId) => inject(app, cookie, 'DELETE', `/api/conversations/${id}/members/${userId}`);

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const ids = (members) => sorted(members.map((m) => m.id));
const rosterEvents = (events) => events.filter((e) => e.event.type === 'members:update');

// bob (a plain, non-admin user) opens the group "Nhà" with carol and dave,
// so bob is its creator; alice is the app admin but NOT a member; erin is
// an outsider. WS/push/notify are stubbed AFTER creation so they only ever
// record what the member routes themselves do.
async function setupGroup() {
  const app = buildTestApp();
  const { alice, others } = await setupUsers(app, 4);
  const [bob, carol, dave, erin] = others;
  const created = await createConversation(app, bob.cookie, { user_ids: [carol.id, dave.id], name: 'Nhà' });
  expect(created.statusCode).toBe(201);
  const group = created.json().conversation;

  const events = [];
  app.pushToUsers = (userIds, event) => {
    events.push({ userIds: [...userIds], event });
  };
  const notifies = [];
  app.notifyNewMessage = async (convId, message, opts) => {
    notifies.push({ convId, message, opts });
  };
  const pushes = [];
  app.sendPush = async (userIds, payload) => {
    pushes.push({ userIds, payload });
  };

  return { app, alice, bob, carol, dave, erin, group, events, notifies, pushes };
}

describe('GET /api/conversations/:id/members', () => {
  it('lists every member with joined_at, and the group exposes its creator as created_by', async () => {
    const { app, bob, carol, dave, group } = await setupGroup();
    expect(group.created_by).toBe(bob.id);

    const res = await getMembers(app, carol.cookie, group.id);

    expect(res.statusCode).toBe(200);
    const members = res.json();
    expect(ids(members)).toEqual(sorted([bob.id, carol.id, dave.id]));
    for (const m of members) {
      expect(typeof m.username).toBe('string');
      expect(typeof m.joined_at).toBe('number');
      expect(m).toHaveProperty('display_name');
      expect(m).toHaveProperty('avatar_at');
    }
  });

  it('returns 403 not_a_member for a non-member', async () => {
    const { app, erin, group } = await setupGroup();

    const res = await getMembers(app, erin.cookie, group.id);

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_a_member');
  });

  it('returns 400 not_a_group for a 1-1 conversation', async () => {
    const { app, alice, bob } = await setupGroup();
    const oneToOne = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;

    const res = await getMembers(app, alice.cookie, oneToOne.id);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not_a_group');
  });

  it('returns 404 for an unknown conversation and 401 without a session', async () => {
    const { app, bob, group } = await setupGroup();

    expect((await getMembers(app, bob.cookie, 9999)).statusCode).toBe(404);
    const anon = await app.inject({ method: 'GET', url: `/api/conversations/${group.id}/members` });
    expect(anon.statusCode).toBe(401);
  });
});

describe('POST /api/conversations/:id/members', () => {
  it('lets any member add a user, who can then read and post; posts a system line and fans out events', async () => {
    const { app, bob, carol, dave, erin, group, events, notifies } = await setupGroup();

    const res = await addMember(app, carol.cookie, group.id, erin.id);

    expect(res.statusCode).toBe(201);
    const { members, message } = res.json();
    expect(ids(members)).toEqual(sorted([bob.id, carol.id, dave.id, erin.id]));
    expect(message.conversation_id).toBe(group.id);
    expect(message.kind).toBe('text');
    expect(message.sender_id).toBe(carol.id);
    expect(message.sender_name).toBe('carol');
    expect(message.body).toBe('➕ carol đã thêm erin vào nhóm');

    // members:update to everyone (erin included), conversation:new to erin
    // alone, and the system line handed to the usual new-message fan-out.
    const roster = rosterEvents(events);
    expect(roster).toHaveLength(1);
    expect(sorted(roster[0].userIds)).toEqual(sorted([bob.id, carol.id, dave.id, erin.id]));
    expect(roster[0].event).toMatchObject({
      conversation_id: group.id,
      action: 'add',
      user_id: erin.id,
      actor_id: carol.id,
    });
    expect(ids(roster[0].event.members)).toEqual(sorted([bob.id, carol.id, dave.id, erin.id]));

    const fresh = events.filter((e) => e.event.type === 'conversation:new');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].userIds).toEqual([erin.id]);
    expect(fresh[0].event.conversation.id).toBe(group.id);
    expect(ids(fresh[0].event.conversation.participants)).toContain(erin.id);

    expect(notifies).toHaveLength(1);
    expect(notifies[0].convId).toBe(group.id);
    expect(notifies[0].message.id).toBe(message.id);
    expect(notifies[0].message.body).toBe(message.body);

    // erin is a full member now: listed, readable, postable.
    expect(ids((await getMembers(app, erin.cookie, group.id)).json())).toContain(erin.id);
    expect((await listConversations(app, erin.cookie)).json().map((c) => c.id)).toEqual([group.id]);
    const history = (await getMessages(app, erin.cookie, group.id)).json();
    expect(history.map((m) => m.body)).toEqual(['➕ carol đã thêm erin vào nhóm']);
    expect(history[0].sender_name).toBe('carol');
    expect((await sendText(app, erin.cookie, group.id, 'chào cả nhà')).statusCode).toBe(201);
  });

  it('returns 400 already_member for someone already in the group, changing nothing', async () => {
    const { app, bob, carol, group, events, notifies } = await setupGroup();

    const res = await addMember(app, bob.cookie, group.id, carol.id);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_member');
    expect((await getMembers(app, bob.cookie, group.id)).json()).toHaveLength(3);
    expect((await getMessages(app, bob.cookie, group.id)).json()).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(notifies).toHaveLength(0);
  });

  it('returns 404 user_not_found for an unknown user and 400 invalid_user_id otherwise', async () => {
    const { app, bob, group } = await setupGroup();

    const missing = await addMember(app, bob.cookie, group.id, 9999);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('user_not_found');

    const garbage = await addMember(app, bob.cookie, group.id, 'x');
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().error).toBe('invalid_user_id');

    const noBody = await app.inject({
      method: 'POST',
      url: `/api/conversations/${group.id}/members`,
      headers: { cookie: bob.cookie },
    });
    expect(noBody.statusCode).toBe(400);
  });

  it('returns 403 not_a_member when a non-member (even the admin) tries to add someone', async () => {
    const { app, alice, erin, group, events } = await setupGroup();

    const res = await addMember(app, alice.cookie, group.id, erin.id);

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_a_member');
    expect((await getMembers(app, erin.cookie, group.id)).statusCode).toBe(403);
    expect(events).toHaveLength(0);
  });

  it('returns 400 not_a_group for a 1-1 conversation', async () => {
    const { app, alice, bob, carol } = await setupGroup();
    const oneToOne = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;

    const res = await addMember(app, alice.cookie, oneToOne.id, carol.id);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not_a_group');
    expect((await getMessages(app, carol.cookie, oneToOne.id)).statusCode).toBe(403);
  });
});

describe('DELETE /api/conversations/:id/members/:userId', () => {
  it('lets any member leave: system line, roster event to the leaver too, and no access afterwards', async () => {
    const { app, bob, carol, dave, group, events, notifies } = await setupGroup();
    const earlier = (await sendText(app, carol.cookie, group.id, 'tạm biệt')).json();
    events.length = 0;
    notifies.length = 0;

    const res = await removeMember(app, carol.cookie, group.id, carol.id);

    expect(res.statusCode).toBe(200);
    const { members, message } = res.json();
    expect(ids(members)).toEqual(sorted([bob.id, dave.id]));
    expect(message.sender_id).toBe(carol.id);
    expect(message.body).toBe('🚪 carol đã rời nhóm');

    // carol is out: the group is gone from her list and every member-only
    // route now answers 403.
    expect((await listConversations(app, carol.cookie)).json()).toEqual([]);
    expect((await getMessages(app, carol.cookie, group.id)).statusCode).toBe(403);
    expect((await sendText(app, carol.cookie, group.id, 'lén')).statusCode).toBe(403);
    expect((await getMembers(app, carol.cookie, group.id)).statusCode).toBe(403);
    const react = await inject(
      app,
      carol.cookie,
      'POST',
      `/api/conversations/${group.id}/messages/${earlier.id}/reactions`,
      { emoji: '👍' },
    );
    expect(react.statusCode).toBe(403);
    const edit = await inject(app, carol.cookie, 'PATCH', `/api/conversations/${group.id}/messages/${earlier.id}`, {
      text: 'x',
    });
    expect(edit.statusCode).toBe(403);

    // The others still see her earlier message plus the system line, both
    // labelled with her name even though she's no longer a participant.
    const history = (await getMessages(app, bob.cookie, group.id)).json();
    expect(history.map((m) => m.body)).toEqual(['tạm biệt', '🚪 carol đã rời nhóm']);
    expect(history.map((m) => m.sender_name)).toEqual(['carol', 'carol']);

    const roster = rosterEvents(events);
    expect(roster).toHaveLength(1);
    expect(sorted(roster[0].userIds)).toEqual(sorted([bob.id, carol.id, dave.id]));
    expect(roster[0].event).toMatchObject({
      conversation_id: group.id,
      action: 'leave',
      user_id: carol.id,
      actor_id: carol.id,
    });
    expect(ids(roster[0].event.members)).toEqual(sorted([bob.id, dave.id]));
    expect(events.some((e) => e.event.type === 'conversation:new')).toBe(false);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].message.id).toBe(message.id);
  });

  it('lets the creator (who is not an admin) remove another member', async () => {
    const { app, bob, carol, dave, group, events } = await setupGroup();

    const res = await removeMember(app, bob.cookie, group.id, dave.id);

    expect(res.statusCode).toBe(200);
    const { members, message } = res.json();
    expect(ids(members)).toEqual(sorted([bob.id, carol.id]));
    expect(message.sender_id).toBe(bob.id);
    expect(message.body).toBe('➖ bob đã xoá dave khỏi nhóm');
    expect((await getMessages(app, dave.cookie, group.id)).statusCode).toBe(403);
    expect((await sendText(app, dave.cookie, group.id, 'ê')).statusCode).toBe(403);
    expect((await listConversations(app, dave.cookie)).json()).toEqual([]);

    const [roster] = rosterEvents(events);
    expect(sorted(roster.userIds)).toEqual(sorted([bob.id, carol.id, dave.id]));
    expect(roster.event).toMatchObject({ action: 'remove', user_id: dave.id, actor_id: bob.id });
    expect(ids(roster.event.members)).toEqual(sorted([bob.id, carol.id]));
  });

  it('lets an app admin who is a member (but not the creator) remove another member', async () => {
    const { app, alice, bob, carol, dave, group } = await setupGroup();
    expect((await addMember(app, bob.cookie, group.id, alice.id)).statusCode).toBe(201);

    const res = await removeMember(app, alice.cookie, group.id, carol.id);

    expect(res.statusCode).toBe(200);
    expect(ids(res.json().members)).toEqual(sorted([alice.id, bob.id, dave.id]));
    expect(res.json().message.body).toBe('➖ alice đã xoá carol khỏi nhóm');
    expect((await getMessages(app, carol.cookie, group.id)).statusCode).toBe(403);
  });

  it('returns 403 not_allowed when a plain member tries to remove someone else, changing nothing', async () => {
    const { app, bob, carol, dave, group, events, notifies } = await setupGroup();

    const res = await removeMember(app, carol.cookie, group.id, dave.id);

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_allowed');
    expect(ids((await getMembers(app, dave.cookie, group.id)).json())).toEqual(sorted([bob.id, carol.id, dave.id]));
    expect((await getMessages(app, bob.cookie, group.id)).json()).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(notifies).toHaveLength(0);
  });

  it('returns 404 member_not_found when the target is not in the group', async () => {
    const { app, bob, erin, group } = await setupGroup();

    const res = await removeMember(app, bob.cookie, group.id, erin.id);

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('member_not_found');
    expect((await removeMember(app, bob.cookie, group.id, 9999)).statusCode).toBe(404);
    expect((await removeMember(app, bob.cookie, group.id, 'x')).statusCode).toBe(400);
  });

  it('returns 403 not_a_member for a non-member and 400 not_a_group on a 1-1 chat', async () => {
    const { app, alice, bob, erin, group } = await setupGroup();

    const outsider = await removeMember(app, erin.cookie, group.id, bob.id);
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().error).toBe('not_a_member');
    // Even the admin can't act on a group they're not in.
    expect((await removeMember(app, alice.cookie, group.id, bob.id)).statusCode).toBe(403);
    expect((await getMembers(app, bob.cookie, group.id)).json()).toHaveLength(3);

    const oneToOne = (await createConversation(app, alice.cookie, { user_ids: [bob.id] })).json().conversation;
    const leave = await removeMember(app, alice.cookie, oneToOne.id, alice.id);
    expect(leave.statusCode).toBe(400);
    expect(leave.json().error).toBe('not_a_group');
    expect((await getMessages(app, alice.cookie, oneToOne.id)).statusCode).toBe(200);
  });

  it('lets the last member leave, leaving an empty conversation behind that nobody lists', async () => {
    const { app, bob, carol, dave, group, events } = await setupGroup();
    expect((await removeMember(app, carol.cookie, group.id, carol.id)).statusCode).toBe(200);
    expect((await removeMember(app, dave.cookie, group.id, dave.id)).statusCode).toBe(200);

    const res = await removeMember(app, bob.cookie, group.id, bob.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual([]);
    const remaining = app.db
      .prepare('SELECT COUNT(*) AS count FROM participants WHERE conversation_id = ?')
      .get(group.id).count;
    expect(remaining).toBe(0);
    expect(app.db.prepare('SELECT id FROM conversations WHERE id = ?').get(group.id)).toBeTruthy();
    for (const u of [bob, carol, dave]) {
      expect((await listConversations(app, u.cookie)).json()).toEqual([]);
      expect((await getMessages(app, u.cookie, group.id)).statusCode).toBe(403);
    }
    // The final roster event still reaches the one who just left.
    const last = rosterEvents(events).at(-1);
    expect(last.userIds).toEqual([bob.id]);
    expect(last.event.members).toEqual([]);
  });
});
