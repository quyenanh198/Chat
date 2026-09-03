// Reconnecting WebSocket client for the server's push channel (GET /ws, at
// the app root — NOT /api/ws, see vite.config.ts's proxy comment). Auth
// rides on the httpOnly lb_session cookie the browser already attaches to
// same-origin WS upgrades, so there's nothing to pass here.
//
// The server only pushes events caused by OTHER users' actions (see
// server/src/app.js's notifyNewMessage/notifyNewConversation/notifyNewStory
// — each explicitly excludes the actor). Whatever a page does itself (send a
// message, create a conversation, post a story) must update local state from
// that request's own response; WS is strictly for hearing about the rest.
import type { Conversation, Member, Message } from './api';

export type WsEvent =
  | { type: 'message:new'; conversation_id: number; message: Message }
  // A group's roster changed. Goes to every current member AND the user who
  // just left / was removed (`user_id`) — not finding yourself in `members`
  // is how a client learns it's out. The matching system line follows as a
  // normal message:new.
  | {
      type: 'members:update';
      conversation_id: number;
      action: 'add' | 'leave' | 'remove';
      user_id: number;
      actor_id: number;
      members: Member[];
    }
  // Unlike message:new this goes to every member, the editor included (their
  // other tabs/devices need it too); `message.reactions` is the neutral shape
  // without the per-viewer `mine` flag, like reaction:update.
  | { type: 'message:edited'; conversation_id: number; message: Message }
  | { type: 'story:new'; user_id: number; story_id: number }
  | { type: 'conversation:new'; conversation: Conversation }
  | {
      type: 'reaction:update';
      conversation_id: number;
      message_id: number;
      message_sender_id: number;
      user_id: number;
      emoji: string;
      reactions: { emoji: string; count: number; names?: string[] }[];
    };

type EventListener = (event: WsEvent) => void;
type OpenListener = () => void;

export interface WsConnection {
  /** Fires for every parsed server event. Returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void;
  /**
   * Fires each time the socket (re)connects, including the very first
   * connect. Pages use this to refetch after a dropped connection may have
   * missed events while it was down.
   */
  onOpen(listener: OpenListener): () => void;
  /** Stops reconnecting and tears down the socket. Call on logout/unmount. */
  close(): void;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function connect(): WsConnection {
  const eventListeners = new Set<EventListener>();
  const openListeners = new Set<OpenListener>();
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = MIN_BACKOFF_MS;
  let closed = false;

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open(): void {
    if (closed) return;
    const socketInstance = new WebSocket(wsUrl());
    socket = socketInstance;

    socketInstance.addEventListener('open', () => {
      backoff = MIN_BACKOFF_MS;
      openListeners.forEach((listener) => listener());
    });

    socketInstance.addEventListener('message', (event: MessageEvent<string>) => {
      let data: WsEvent;
      try {
        data = JSON.parse(event.data) as WsEvent;
      } catch {
        return; // ignore malformed frames
      }
      eventListeners.forEach((listener) => listener(data));
    });

    socketInstance.addEventListener('close', () => {
      if (socket === socketInstance) socket = null;
      scheduleReconnect();
    });

    socketInstance.addEventListener('error', () => {
      socketInstance.close();
    });
  }

  open();

  return {
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onOpen(listener) {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
      eventListeners.clear();
      openListeners.clear();
    },
  };
}
