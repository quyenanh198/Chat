// Typed fetch wrapper for the Lazybutts API. Every call sends
// credentials:'include' so the httpOnly lb_session cookie rides along, and
// every non-2xx response throws an ApiError built from the server's parsed
// {error: "..."} body (falling back to the HTTP status text when the body
// isn't JSON, e.g. a raw 413 from the multipart size limit).
//
// Types below mirror the server's actual response shapes exactly (see
// server/src/routes/*.js) — several of them (GET /me, POST /conversations/:id/messages,
// GET /conversations, GET /stories, ...) return the resource directly rather
// than wrapped in an envelope, so callers must not assume a uniform shape.

export interface User {
  id: number;
  username: string;
  display_name?: string;
  avatar_at?: number | null;
  is_admin: boolean;
  media_mode: 'once' | '24h';
  farm_notify?: boolean;
}

export interface Participant {
  id: number;
  username: string;
  display_name?: string;
  avatar_at?: number | null;
}

export interface LastMessage {
  id: number;
  sender_id: number;
  kind: 'text' | 'image' | 'video';
  created_at: number;
  body: string | null;
}

export interface Conversation {
  id: number;
  is_group: boolean;
  name: string | null;
  // Who opened it; may remove members from a group (so may an admin). null
  // for conversations from before the server tracked this.
  created_by?: number | null;
  created_at: number;
  participants: Participant[];
  last_message: LastMessage | null;
  unread_count: number;
}

export interface Message {
  reactions?: Reaction[];
  reply?: { id: number; sender_name: string; snippet: string } | null;
  id: number;
  conversation_id: number;
  sender_id: number;
  kind: 'text' | 'image' | 'video';
  body: string | null;
  media_mode: 'once' | '24h' | null;
  created_at: number;
  expires_at: number;
  // Author's name as of the fetch — the fallback for labelling a message
  // from someone who has since left the group (no longer a participant).
  sender_name?: string | null;
  // ms timestamp of the author's last edit (text messages only); null until then.
  edited_at?: number | null;
  // Present on media messages (kind image/video) only, computed per the
  // requesting user's view of the once/24h rules.
  viewable?: boolean;
  viewed?: boolean;
}

export interface Story {
  id: number;
  user_id: number;
  kind: 'image' | 'video';
  created_at: number;
  expires_at?: number;
}

export interface StoryFeedItem {
  id: number;
  kind: 'image' | 'video';
  created_at: number;
  viewed: boolean;
}

export interface StoryGroup {
  user: Participant;
  stories: StoryFeedItem[];
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function parseErrorBody(res: Response): Promise<{ error?: string }> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return {};
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(body.error ?? res.statusText, res.status, body);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>(path, jsonInit('POST', body)),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>(path, jsonInit('PATCH', body)),
  del: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, file: Blob, fieldName = 'file'): Promise<T> => {
    const form = new FormData();
    form.append(fieldName, file);
    return request<T>(path, { method: 'POST', body: form });
  },
};

// --- Convenience wrappers for the routes the frontend calls ---

export function updateProfile(display_name: string): Promise<{ user: User }> {
  return api.patch('/api/me/profile', { display_name });
}

export function login(username: string, password: string): Promise<{ user: User }> {
  return api.post('/api/auth/login', { username, password });
}

export function register(username: string, password: string, invite?: string): Promise<{ user: User }> {
  return api.post('/api/auth/register', { username, password, invite });
}

export function logout(): Promise<{ ok: boolean }> {
  return api.post('/api/auth/logout');
}

export function getMe(): Promise<User> {
  return api.get('/api/me');
}

export type SettingsPatch = Partial<Pick<User, 'media_mode' | 'farm_notify'>>;
export function updateSettings(patch: User['media_mode'] | SettingsPatch): Promise<{ user: User }> {
  return api.patch('/api/me/settings', typeof patch === 'string' ? { media_mode: patch } : patch);
}

export function getUsers(): Promise<Participant[]> {
  return api.get('/api/users');
}

export function getConversations(): Promise<Conversation[]> {
  return api.get('/api/conversations');
}

export function createConversation(user_ids: number[], name?: string): Promise<{ conversation: Conversation }> {
  return api.post('/api/conversations', { user_ids, name });
}

export function getMessages(conversationId: number): Promise<Message[]> {
  return api.get(`/api/conversations/${conversationId}/messages`);
}

// A group member as GET /conversations/:id/members lists them.
export interface Member extends Participant {
  joined_at: number;
}

export function getMembers(conversationId: number): Promise<Member[]> {
  return api.get(`/api/conversations/${conversationId}/members`);
}

// Both reply with the new roster plus the system line posted about the
// change ("➕ A đã thêm B vào nhóm") — as the actor you don't get that line
// over WS (message:new skips its sender), so append it from here.
export interface MembersChange {
  ok: boolean;
  members: Member[];
  message: Message;
}

export function addMember(conversationId: number, userId: number): Promise<MembersChange> {
  return api.post(`/api/conversations/${conversationId}/members`, { userId });
}

// Removing yourself leaves the group; removing someone else takes the
// group's creator or an admin (403 not_allowed otherwise).
export function removeMember(conversationId: number, userId: number): Promise<MembersChange> {
  return api.del(`/api/conversations/${conversationId}/members/${userId}`);
}

export interface Reaction {
  emoji: string;
  count: number;
  mine?: boolean;
  names?: string[];
}

export interface GifResult {
  id: string;
  preview: string;
  url: string;
}

export function searchGifs(q: string): Promise<{ results: GifResult[] }> {
  return api.get(`/api/gif/search?q=${encodeURIComponent(q)}`);
}

export function searchMemes(q: string): Promise<{ results: GifResult[] }> {
  return api.get(`/api/gif/memes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
}

export interface CustomSticker {
  id: number;
  url: string;
  mine: boolean;
}

export function listStickers(): Promise<{ results: CustomSticker[] }> {
  return api.get('/api/stickers');
}

export function uploadSticker(file: Blob): Promise<CustomSticker> {
  return api.upload('/api/stickers', file);
}

export function deleteSticker(id: number): Promise<{ ok: boolean }> {
  return api.del(`/api/stickers/${id}`);
}

export function setReaction(conversationId: number, messageId: number, emoji: string): Promise<{ ok: boolean; reactions: Reaction[] }> {
  return api.post(`/api/conversations/${conversationId}/messages/${messageId}/reactions`, { emoji });
}

export function sendMessage(conversationId: number, body: string, replyTo?: number): Promise<Message> {
  return api.post(`/api/conversations/${conversationId}/messages`, { body, reply_to: replyTo });
}

export function editMessage(conversationId: number, messageId: number, text: string): Promise<Message> {
  return api.patch(`/api/conversations/${conversationId}/messages/${messageId}`, { text });
}

export function sendMedia(conversationId: number, file: Blob): Promise<Message> {
  return api.upload(`/api/conversations/${conversationId}/media`, file);
}

export function uploadAvatar(file: Blob): Promise<{ user: User }> {
  return api.upload('/api/me/avatar', file);
}

export function avatarUrl(id: number, avatarAt?: number | null): string | null {
  return avatarAt ? `/api/users/${id}/avatar?v=${avatarAt}` : null;
}

export function getStories(): Promise<StoryGroup[]> {
  return api.get('/api/stories');
}

export function postStory(file: Blob): Promise<Story> {
  return api.upload('/api/stories', file);
}

export function getVapidKey(): Promise<{ publicKey: string }> {
  return api.get('/api/push/vapid');
}

export function subscribePush(subscription: PushSubscriptionPayload): Promise<{ ok: boolean }> {
  return api.post('/api/push/subscribe', { subscription });
}

export interface PushStatus {
  enabled: boolean;
  devices: { endpoint: string; created_at: number }[];
}

export function getPushStatus(): Promise<PushStatus> {
  return api.get('/api/push/status');
}

export interface PushTestResult {
  sent: number;
  results: { status: number; error: string | null; host: string }[];
}

export function sendPushTest(): Promise<PushTestResult> {
  return api.post('/api/push/test', {});
}

export function createInvite(): Promise<{ code: string }> {
  return api.post('/api/invites');
}
