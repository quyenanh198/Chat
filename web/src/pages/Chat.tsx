import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  getConversations,
  getMessages,
  sendMedia,
  sendMessage,
  type Conversation,
  type Message,
} from '../api';
import { useAuth } from '../AuthContext';
import { fetchMediaBlobUrl } from '../mediaBlob';
import { connect, type WsConnection } from '../ws';

interface MediaViewerState {
  message: Message;
  url: string;
}

function conversationTitle(conversation: Conversation | null, meId: number): string {
  if (!conversation) return 'Chat';
  if (conversation.is_group) return conversation.name ?? 'Group chat';
  return conversation.participants.find((p) => p.id !== meId)?.username ?? 'Unknown';
}

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const conversationId = Number(id);
  const { user } = useAuth();
  const navigate = useNavigate();
  const meId = user?.id ?? -1;

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const [viewer, setViewer] = useState<MediaViewerState | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [openingMessageId, setOpeningMessageId] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const participantNames = useMemo(() => {
    const map = new Map<number, string>();
    conversation?.participants.forEach((p) => map.set(p.id, p.username));
    return map;
  }, [conversation]);

  const loadMessages = useCallback(async () => {
    if (!Number.isInteger(conversationId)) return;
    try {
      const list = await getMessages(conversationId);
      setMessages(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load messages');
    }
  }, [conversationId]);

  const loadConversationMeta = useCallback(async () => {
    try {
      const list = await getConversations();
      setConversation(list.find((c) => c.id === conversationId) ?? null);
    } catch {
      // header falls back to a generic title if this fails
    }
  }, [conversationId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadMessages(), loadConversationMeta()]).finally(() => setLoading(false));
  }, [loadMessages, loadConversationMeta]);

  useEffect(() => {
    const conn: WsConnection = connect();
    const offEvent = conn.onEvent((event) => {
      if (event.type === 'message:new' && event.conversation_id === conversationId) {
        setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message]));
      }
    });
    // A reconnect may have missed events while the socket was down.
    const offOpen = conn.onOpen(() => {
      loadMessages();
    });
    return () => {
      offEvent();
      offOpen();
      conn.close();
    };
  }, [conversationId, loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  // closeViewer() already revokes the blob URL on an explicit close, but
  // navigating away (unmount) while the viewer is still open would leak it
  // otherwise — mirrors the revoke-on-cleanup pattern in Story.tsx.
  const viewerRef = useRef<MediaViewerState | null>(null);
  useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);
  useEffect(() => {
    return () => {
      if (viewerRef.current) URL.revokeObjectURL(viewerRef.current.url);
    };
  }, []);

  async function handleSendText(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const message = await sendMessage(conversationId, body);
      setMessages((prev) => [...prev, message]);
      setText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setSending(true);
    try {
      const message = await sendMedia(conversationId, file);
      // The server's POST /conversations/:id/media response never carries
      // viewable/viewed (serializeMessage in server/src/routes/media.js
      // omits them — those fields only exist on the GET .../messages read
      // path, computed per-viewer). Fill them in optimistically so this
      // bubble renders as "Tap to view" immediately instead of "Opened";
      // the render below additionally treats the sender as always-viewable
      // regardless of this field, as a second line of defense.
      setMessages((prev) => [...prev, { ...message, viewable: true, viewed: false }]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send media');
    } finally {
      setSending(false);
    }
  }

  async function openMedia(message: Message) {
    setOpeningMessageId(message.id);
    setViewerError(null);
    try {
      const url = await fetchMediaBlobUrl(`/api/media/${message.id}`);
      setViewer({ message, url });
    } catch (err) {
      setViewerError(err instanceof ApiError ? err.message : 'Failed to load media');
      // The 403 already_viewed race (another tab/device viewed it first) is
      // exactly what a refetch corrects: it flips this bubble to "Opened".
      loadMessages();
    } finally {
      setOpeningMessageId(null);
    }
  }

  function closeViewer() {
    if (viewer) URL.revokeObjectURL(viewer.url);
    setViewer(null);
    // Re-fetch so a once-mode bubble flips to "Opened" (or disappears, once
    // every recipient has viewed it and the server deleted the message).
    loadMessages();
  }

  const title = conversationTitle(conversation, meId);

  return (
    <div className="chat-page">
      <header className="chat-header">
        <button type="button" className="icon-button" onClick={() => navigate('/')} aria-label="Back">
          ←
        </button>
        <h1>{title}</h1>
      </header>

      <div className="message-list">
        {loading && <p className="muted-note">Loading messages…</p>}
        {!loading && error && <p className="inline-error">{error}</p>}
        {!loading && messages.length === 0 && !error && (
          <p className="muted-note">No messages yet. Say hi.</p>
        )}
        {messages.map((message) => {
          const isMine = message.sender_id === meId;
          const senderName = participantNames.get(message.sender_id);
          return (
            <div key={message.id} className={`bubble-row${isMine ? ' bubble-row--mine' : ''}`}>
              <div className="bubble">
                {conversation?.is_group && !isMine && senderName && (
                  <div className="bubble-sender">{senderName}</div>
                )}
                {message.kind === 'text' && <div className="bubble-text">{message.body}</div>}
                {message.kind !== 'text' &&
                  // The sender can always re-view their own media until it
                  // expires (per spec) — the server's mediaFlags() already
                  // returns viewable:true for the sender on the GET
                  // .../messages read path, but the POST .../media response
                  // that lands here right after sending doesn't carry the
                  // field at all (see the comment in handleFileChange), so
                  // `isMine` is the authoritative fallback rather than
                  // trusting `message.viewable` alone.
                  ((isMine || message.viewable) ? (
                    <button
                      type="button"
                      className="bubble-media-cta"
                      onClick={() => openMedia(message)}
                      disabled={openingMessageId === message.id}
                    >
                      {message.kind === 'video' ? '🎥' : '📷'}{' '}
                      {openingMessageId === message.id ? 'Loading…' : 'Tap to view'}
                    </button>
                  ) : (
                    <div className="bubble-media-opened">Opened</div>
                  ))}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={handleSendText}>
        <button
          type="button"
          className="icon-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
          aria-label="Send photo or video"
        >
          📷
        </button>
        <input ref={fileInputRef} type="file" accept="image/*,video/*" capture hidden onChange={handleFileChange} />
        <input
          className="composer-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Message"
          disabled={sending}
        />
        <button type="submit" disabled={sending || text.trim().length === 0}>
          Send
        </button>
      </form>

      {viewer && (
        <div className="media-viewer-overlay" onClick={closeViewer}>
          <button type="button" className="media-viewer-close" onClick={closeViewer} aria-label="Close">
            ✕
          </button>
          {viewer.message.kind === 'video' ? (
            <video src={viewer.url} controls autoPlay onClick={(event) => event.stopPropagation()} />
          ) : (
            <img src={viewer.url} alt="" onClick={(event) => event.stopPropagation()} />
          )}
        </div>
      )}
      {viewerError && (
        <div className="toast toast--error" onClick={() => setViewerError(null)}>
          {viewerError}
        </div>
      )}
    </div>
  );
}
