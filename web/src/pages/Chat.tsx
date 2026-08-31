import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  avatarUrl,
  deleteSticker,
  listStickers,
  uploadSticker,
  type CustomSticker,
  searchGifs,
  searchMemes,
  setReaction,
  type GifResult,
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
  const other = conversation.participants.find((p) => p.id !== meId);
  return other ? (other.display_name || other.username) : 'Unknown';
}

// Các bộ sticker quen mặt với người Việt, đã kiểm tra có trên Giphy.
const MEME_PACKS: { label: string; q: string }[] = [
  { label: 'Nhà 🏠', q: '__custom__' },
  { label: 'Hot', q: '' },
  { label: 'Quby', q: 'quby' },
  { label: 'Mochi Cat', q: 'mochi mochi peach cat' },
  { label: 'Peach & Goma', q: 'peach goma' },
  { label: 'Milk & Mocha', q: 'milk mocha' },
  { label: 'TonTon', q: 'tonton friends' },
  { label: 'Capoo', q: 'capoo' },
  { label: 'Menhera', q: 'menhera' },
  { label: 'Tuzki', q: 'tuzki' },
  { label: 'Cheems', q: 'cheems' },
  { label: 'Bé Heo', q: 'bé heo' },
  { label: 'Mèo hư', q: 'sassy cat' },
  { label: 'Mèo quạu', q: 'angry white cat' },
];

const QUICK_REACTIONS = ['❤️', '😂', '👍', '😮', '😢', '🔥'];
const EMOJI_PANEL = ['😀','😁','😂','🤣','😊','😍','😘','😜','🤔','😴','😭','😱','😡','🥳','🤗','👍','👎','👏','🙏','💪','🔥','✨','🎉','❤️','💔','😅','🙈','🤝','😷','🤯','😇','🥰','😋','🤤','🍜','⚡'];
const PAGE_GIF_RE = /^https?:\/\/(www\.)?(giphy\.com\/gifs\/|tenor\.com\/view\/)\S+$/i;
const IMAGE_URL_RE = /^https?:\/\/\S+\.(gif|png|jpe?g|webp)(\?\S*)?$/i;

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const conversationId = Number(id);
  const { user } = useAuth();
  const navigate = useNavigate();
  const meId = user?.id ?? -1;

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [allConversations, setAllConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [reactingId, setReactingId] = useState<number | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showGif, setShowGif] = useState(false);
  const [showMeme, setShowMeme] = useState(false);
  const [memeQuery, setMemeQuery] = useState('');
  const [memeResults, setMemeResults] = useState<GifResult[]>([]);
  const [memeStatus, setMemeStatus] = useState<string | null>(null);
  const [memePack, setMemePack] = useState('');
  const [customStickers, setCustomStickers] = useState<CustomSticker[]>([]);
  const [stickerBusy, setStickerBusy] = useState(false);
  const stickerFileRef = useRef<HTMLInputElement>(null);
  const [gifQuery, setGifQuery] = useState('');
  const [gifResults, setGifResults] = useState<GifResult[]>([]);
  const [gifStatus, setGifStatus] = useState<string | null>(null);
  const [resolvedEmbeds, setResolvedEmbeds] = useState<Record<string, string | null>>({});
  const [replyTarget, setReplyTarget] = useState<{ id: number; name: string; snippet: string } | null>(null);
  const resolvingRef = useRef<Set<string>>(new Set());

  const [recentGifs, setRecentGifs] = useState<GifResult[]>(() => {
    try { return JSON.parse(localStorage.getItem('chat.recentGifs') || '[]'); } catch { return []; }
  });

  const [viewer, setViewer] = useState<MediaViewerState | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [openingMessageId, setOpeningMessageId] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);

  const participantNames = useMemo(() => {
    const map = new Map<number, string>();
    conversation?.participants.forEach((p) => map.set(p.id, p.display_name || p.username));
    return map;
  }, [conversation]);

  const participantAvatars = useMemo(() => {
    const map = new Map<number, string | null>();
    conversation?.participants.forEach((p) => map.set(p.id, avatarUrl(p.id, p.avatar_at)));
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
      setAllConversations(list);
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

  const scrollToBottom = useCallback(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    else bottomRef.current?.scrollIntoView({ block: 'end' });
  }, []);

  // Late-loading embeds (gifs/stickers) grow the list after the initial
  // scroll — follow the bottom only if the user is already near it.
  const scrollIfNearBottom = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 240) {
      list.scrollTop = list.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Live reaction updates arrive with neutral counts; recompute my own flag.
  useEffect(() => {
    const conn: WsConnection = connect();
    const off = conn.onEvent((event: any) => {
      if (event.type !== 'reaction:update' || event.conversation_id !== conversationId) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== event.message_id) return m;
          const prevMine = event.user_id === meId
            ? (event.emoji || null)
            : (m.reactions?.find((r) => r.mine)?.emoji ?? null);
          return {
            ...m,
            reactions: (event.reactions as { emoji: string; count: number }[]).map((r) => ({
              ...r,
              mine: r.emoji === prevMine,
            })),
          };
        }),
      );
    });
    return () => {
      off();
      conn.close();
    };
  }, [conversationId, meId]);


  // Resolve pasted giphy/tenor page links to direct media (server og:image).
  useEffect(() => {
    for (const m of messages) {
      const body = m.kind === 'text' ? (m.body ?? '') : '';
      if (!PAGE_GIF_RE.test(body)) continue;
      if (body in resolvedEmbeds || resolvingRef.current.has(body)) continue;
      resolvingRef.current.add(body);
      fetch(`/api/embed/resolve?url=${encodeURIComponent(body)}`)
        .then((r) => (r.ok ? r.json() : { url: null }))
        .then(({ url }) => setResolvedEmbeds((prev) => ({ ...prev, [body]: url ?? null })))
        .catch(() => setResolvedEmbeds((prev) => ({ ...prev, [body]: null })));
    }
  }, [messages, resolvedEmbeds]);

  // Keep the composer focused: on entering the chat, and again the moment a
  // send finishes — the input is disabled while sending, which drops focus.
  useEffect(() => {
    if (!loading && !sending) composerRef.current?.focus();
  }, [loading, sending]);

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

  function startReply(message: Message) {
    setReactingId(null);
    const name = participantNames.get(message.sender_id) ?? '';
    const snippet = message.kind === 'image' ? '📷 Photo' : message.kind === 'video' ? '🎥 Video' : (message.body ?? '').slice(0, 90);
    setReplyTarget({ id: message.id, name, snippet });
    composerRef.current?.focus();
  }

  async function toggleReaction(message: Message, emoji: string) {
    setReactingId(null);
    const already = message.reactions?.some((r) => r.mine && r.emoji === emoji);
    try {
      const { reactions } = await setReaction(conversationId, message.id, already ? '' : emoji);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, reactions } : m)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to react');
    }
  }

  async function handleSendText(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const message = await sendMessage(conversationId, body, replyTarget?.id);
      setMessages((prev) => [...prev, message]);
      setText('');
      setReplyTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  async function sendFile(file: File) {
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

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void sendFile(file);
  }

  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
    if (file) {
      event.preventDefault();
      void sendFile(file);
    }
  }

  function recordRecent(gif: GifResult) {
    setRecentGifs((prev) => {
      const next = [gif, ...prev.filter((g) => g.url !== gif.url)].slice(0, 16);
      try { localStorage.setItem('chat.recentGifs', JSON.stringify(next)); } catch {}
      return next;
    });
  }

  async function loadGifs(q: string) {
    setGifStatus('Đang tải…');
    setGifResults([]);
    try {
      const { results } = await searchGifs(q.trim());
      setGifResults(results);
      setGifStatus(results.length ? null : 'Không thấy GIF nào.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '';
      setGifStatus(
        msg === 'gif_disabled'
          ? 'Chưa bật GIF search — thêm GIF_GIPHY_KEY (Giphy API) vào server. Vẫn dán được link GIF vào ô chat.'
          : 'Tìm GIF thất bại, thử lại.',
      );
    }
  }

  function openGifPanel() {
    const next = !showGif;
    setShowGif(next);
    setShowEmoji(false);
    setShowMeme(false);
    if (next && gifResults.length === 0) void loadGifs('');
  }

  async function runGifSearch() {
    const q = gifQuery.trim();
    if (!q) return;
    await loadGifs(q);
  }

  async function loadMemes(q: string) {
    setMemeStatus('Đang tải…');
    setMemeResults([]);
    try {
      const { results } = await searchMemes(q.trim());
      setMemeResults(results);
      setMemeStatus(results.length ? null : 'Không thấy meme nào.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '';
      setMemeStatus(msg === 'gif_disabled' ? 'Chưa bật Giphy (GIF_GIPHY_KEY).' : 'Tải meme thất bại.');
    }
  }

  async function loadCustomStickers() {
    try {
      const { results } = await listStickers();
      setCustomStickers(results);
      setMemeStatus(results.length ? null : 'Chưa có sticker nào — bấm ＋ để thêm.');
    } catch {
      setMemeStatus('Không tải được sticker.');
    }
  }

  async function handleStickerUpload(file: File | undefined) {
    if (!file) return;
    setStickerBusy(true);
    try {
      await uploadSticker(file);
      await loadCustomStickers();
    } catch (err) {
      setMemeStatus(err instanceof ApiError ? err.message : 'Thêm sticker thất bại');
    } finally {
      setStickerBusy(false);
    }
  }

  async function handleStickerDelete(id: number) {
    try {
      await deleteSticker(id);
      setCustomStickers((prev) => prev.filter((st) => st.id !== id));
    } catch (err) {
      setMemeStatus(err instanceof ApiError ? err.message : 'Xoá thất bại');
    }
  }

  function sendCustomSticker(st: CustomSticker) {
    void sendGif({ id: String(st.id), preview: st.url, url: `${location.origin}${st.url}` });
  }

  function openMemePanel() {
    const next = !showMeme;
    setShowMeme(next);
    setShowGif(false);
    setShowEmoji(false);
    if (next && memeResults.length === 0) void loadMemes('');
  }

  async function sendGif(gif: GifResult) {
    recordRecent(gif);
    setShowGif(false);
    setShowMeme(false);
    setGifResults([]);
    setGifQuery('');
    setSending(true);
    try {
      const message = await sendMessage(conversationId, gif.url);
      setMessages((prev) => [...prev, message]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send GIF');
    } finally {
      setSending(false);
    }
  }

  function insertEmoji(emoji: string) {
    const input = composerRef.current;
    if (!input) {
      setText((t) => t + emoji);
      return;
    }
    const start = input.selectionStart ?? text.length;
    const end = input.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      input.focus();
      const pos = start + emoji.length;
      input.setSelectionRange(pos, pos);
    });
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
  const sidebarRows = useMemo(
    () =>
      [...allConversations].sort((a, b) => {
        const ta = a.last_message?.created_at ?? a.created_at;
        const tb = b.last_message?.created_at ?? b.created_at;
        return tb - ta;
      }),
    [allConversations],
  );

  function rowTitle(c: Conversation) {
    if (c.is_group) return c.name ?? 'Group chat';
    const other = c.participants.find((p) => p.id !== meId);
    return other ? (other.display_name || other.username) : 'Unknown';
  }

  function rowPreview(c: Conversation) {
    const lm = c.last_message;
    if (!lm) return 'No messages yet';
    if (lm.kind === 'image') return '📷 Photo';
    if (lm.kind === 'video') return '🎥 Video';
    return lm.body ?? '';
  }

  function rowAvatar(c: Conversation) {
    if (c.is_group) return null;
    const other = c.participants.find((p) => p.id !== meId);
    return other ? avatarUrl(other.id, other.avatar_at) : null;
  }


  const title = conversationTitle(conversation, meId);

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head">
          <Link to="/" className="icon-button" aria-label="Home">🏠</Link>
          <span className="chat-sidebar-title">Chat</span>
        </div>
        <div className="chat-sidebar-list">
          {sidebarRows.map((c) => (
            <Link
              key={c.id}
              to={`/chat/${c.id}`}
              className={`conversation-row${c.id === conversationId ? ' conversation-row--active' : ''}`}
            >
              <span className="conversation-avatar">
                {rowAvatar(c)
                  ? <img className="avatar-img" src={rowAvatar(c)!} alt="" />
                  : rowTitle(c).charAt(0).toUpperCase()}
              </span>
              <span className="conversation-body">
                <span className="conversation-title">{rowTitle(c)}</span>
                <span className="conversation-preview">{rowPreview(c)}</span>
              </span>
            </Link>
          ))}
        </div>
      </aside>
    <div className="chat-page">
      <header className="chat-header">
        <button type="button" className="icon-button" onClick={() => navigate('/')} aria-label="Back">
          ←
        </button>
        <span className="chat-header-avatar">
          {(() => {
            const other = conversation && !conversation.is_group
              ? conversation.participants.find((p) => p.id !== meId)
              : null;
            const url = other ? avatarUrl(other.id, other.avatar_at) : null;
            return url
              ? <img className="avatar-img" src={url} alt="" />
              : (title || '?').charAt(0).toUpperCase();
          })()}
        </span>
        <h1>{title}</h1>
      </header>

      <div className="message-list" ref={listRef}>
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
              {!isMine && (
                <span className="msg-avatar" title={senderName ?? ''}>
                  {participantAvatars.get(message.sender_id)
                    ? <img className="avatar-img" src={participantAvatars.get(message.sender_id)!} alt="" />
                    : (senderName ?? '?').charAt(0).toUpperCase()}
                </span>
              )}
              <div className="bubble-stack">
                {reactingId === message.id && (
                  <div className="react-palette" onClick={(e) => e.stopPropagation()}>
                    {QUICK_REACTIONS.map((emoji) => (
                      <button key={emoji} type="button" onClick={() => toggleReaction(message, emoji)}>
                        {emoji}
                      </button>
                    ))}
                    <button type="button" className="react-reply" onClick={() => startReply(message)}>↩</button>
                  </div>
                )}
              <div
                className="bubble"
                onClick={() => setReactingId((cur) => (cur === message.id ? null : message.id))}
              >
                {conversation?.is_group && !isMine && senderName && (
                  <div className="bubble-sender">{senderName}</div>
                )}
                {message.reply && (
                  <div className="bubble-quote">
                    <span className="bubble-quote-name">{message.reply.sender_name}</span>
                    <span className="bubble-quote-text">{message.reply.snippet}</span>
                  </div>
                )}
                {message.kind === 'text' &&
                  (IMAGE_URL_RE.test(message.body ?? '') ? (
                    <img className="bubble-img" src={message.body!} alt="" loading="lazy" onLoad={scrollIfNearBottom} />
                  ) : PAGE_GIF_RE.test(message.body ?? '') && resolvedEmbeds[message.body!] ? (
                    <img className="bubble-img" src={resolvedEmbeds[message.body!]!} alt="" loading="lazy" onLoad={scrollIfNearBottom} />
                  ) : PAGE_GIF_RE.test(message.body ?? '') && resolvedEmbeds[message.body!] === undefined ? (
                    <div className="bubble-text bubble-text--loading">Đang tải GIF…</div>
                  ) : (
                    <div className="bubble-text">{message.body}</div>
                  ))}
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
              {(message.reactions?.length ?? 0) > 0 && (
                <div className={`reaction-row${isMine ? ' reaction-row--mine' : ''}`}>
                  {message.reactions!.map((r) => (
                    <button
                      key={r.emoji}
                      type="button"
                      className={`reaction-chip${r.mine ? ' reaction-chip--mine' : ''}`}
                      title={r.names?.join(', ')}
                      onClick={() => toggleReaction(message, r.emoji)}
                    >
                      {r.emoji} {r.count > 1 ? r.count : ''}
                    </button>
                  ))}
                </div>
              )}
              </div>
              <span className="bubble-actions">
                {QUICK_REACTIONS.map((emoji) => (
                  <button key={emoji} type="button" onClick={() => toggleReaction(message, emoji)}>
                    {emoji}
                  </button>
                ))}
                <button type="button" className="bubble-actions-reply" aria-label="Reply" onClick={() => startReply(message)}>
                  ↩
                </button>
              </span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {replyTarget && (
        <div className="reply-strip">
          <div className="reply-strip-body">
            <span className="bubble-quote-name">Trả lời {replyTarget.name}</span>
            <span className="bubble-quote-text">{replyTarget.snippet}</span>
          </div>
          <button type="button" className="icon-button" onClick={() => setReplyTarget(null)} aria-label="Huỷ trả lời">✕</button>
        </div>
      )}
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
        <button
          type="button"
          className="icon-button"
          onClick={() => { setShowEmoji((v) => !v); setShowGif(false); setShowMeme(false); }}
          aria-label="Emoji"
        >
          😊
        </button>
        <button
          type="button"
          className="icon-button gif-button"
          onClick={openGifPanel}
          aria-label="GIF"
        >
          GIF
        </button>
        <button type="button" className="icon-button" onClick={openMemePanel} aria-label="Meme sticker">
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8l-6 6H6a2 2 0 0 1-2-2V6Z" />
            <path d="M14 20v-4a2 2 0 0 1 2-2h4" />
            <circle cx="9" cy="10" r="0.6" fill="currentColor" />
            <circle cx="15" cy="10" r="0.6" fill="currentColor" />
            <path d="M9 13.5c.8.9 1.8 1.4 3 1.4" />
          </svg>
        </button>
        <input
          ref={composerRef}
          className="composer-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={handlePaste}
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
      <aside className="chat-panel-col">
      {showMeme && (
        <div className="gif-panel">
          {recentGifs.length > 0 && (
            <div className="recent-strip">
              <span className="recent-label">Hay dùng</span>
              {recentGifs.map((g) => (
                <button key={g.url} type="button" onClick={() => sendGif(g)}>
                  <img src={g.preview} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
          <div className="meme-packs">
            {MEME_PACKS.map((pack) => (
              <button
                key={pack.label}
                type="button"
                className={`meme-pack-chip${memePack === pack.q ? ' meme-pack-chip--on' : ''}`}
                onClick={() => { setMemePack(pack.q); setMemeQuery(''); if (pack.q === '__custom__') { setMemeResults([]); void loadCustomStickers(); } else { void loadMemes(pack.q); } }}
              >
                {pack.label}
              </button>
            ))}
          </div>
          <div className="gif-search-row">
            <input
              className="composer-input"
              value={memeQuery}
              onChange={(e) => setMemeQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setMemePack('__search__'); loadMemes(memeQuery); } }}
              placeholder="Tìm meme, sticker…"
            />
            <button type="button" className="primary-button" onClick={() => { setMemePack('__search__'); loadMemes(memeQuery); }}>Tìm</button>
          </div>
          {memeStatus && <p className="muted-note">{memeStatus}</p>}
          {memePack === '__custom__' ? (
            <div className="gif-grid gif-grid--memes">
              <button type="button" className="sticker-add" disabled={stickerBusy}
                onClick={() => stickerFileRef.current?.click()}>
                {stickerBusy ? '…' : '＋'}
              </button>
              <input ref={stickerFileRef} type="file" accept="image/*" hidden
                onChange={(e) => { handleStickerUpload(e.target.files?.[0]); e.target.value = ''; }} />
              {customStickers.map((st) => (
                <span key={st.id} className="sticker-cell">
                  <button type="button" onClick={() => sendCustomSticker(st)}>
                    <img src={st.url} alt="" loading="lazy" />
                  </button>
                  {st.mine && (
                    <button type="button" className="sticker-del" aria-label="Xoá sticker"
                      onClick={() => handleStickerDelete(st.id)}>✕</button>
                  )}
                </span>
              ))}
            </div>
          ) : (
            <div className="gif-grid gif-grid--memes">
              {memeResults.map((m) => (
                <button key={m.id} type="button" onClick={() => sendGif(m)}>
                  <img src={m.preview} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {showGif && (
        <div className="gif-panel">
          {recentGifs.length > 0 && (
            <div className="recent-strip">
              <span className="recent-label">Hay dùng</span>
              {recentGifs.map((g) => (
                <button key={g.url} type="button" onClick={() => sendGif(g)}>
                  <img src={g.preview} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
          <div className="gif-search-row">
            <input
              className="composer-input"
              value={gifQuery}
              onChange={(e) => setGifQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runGifSearch(); } }}
              placeholder="Tìm GIF (mèo, haha, chúc mừng…)"
            />
            <button type="button" className="primary-button" onClick={runGifSearch}>Tìm</button>
          </div>
          {gifStatus && <p className="muted-note">{gifStatus}</p>}
          <div className="gif-grid">
            {gifResults.map((gif) => (
              <button key={gif.id} type="button" onClick={() => sendGif(gif)}>
                <img src={gif.preview} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}
      {showEmoji && (
        <div className="emoji-panel">
          {EMOJI_PANEL.map((emoji) => (
            <button key={emoji} type="button" onClick={() => insertEmoji(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}
      </aside>
    </div>
  );
}
