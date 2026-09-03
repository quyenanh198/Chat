import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  addMember,
  avatarUrl,
  deleteSticker,
  getMembers,
  getUsers,
  listStickers,
  removeMember,
  uploadSticker,
  type CustomSticker,
  searchGifs,
  searchMemes,
  setReaction,
  type GifResult,
  getConversations,
  getMessages,
  editMessage,
  sendMedia,
  sendMessage,
  type Conversation,
  type Message,
  type Participant,
} from '../api';
import { useAuth } from '../AuthContext';
import { fetchMediaBlobUrl } from '../mediaBlob';
import { connect, type WsConnection, type WsEvent } from '../ws';

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
// Tin text mà thực chất là GIF/sticker/ảnh link — hiện như ảnh, không cho sửa.
const isEmbedBody = (body: string): boolean => IMAGE_URL_RE.test(body) || PAGE_GIF_RE.test(body);
// "@all" và các cách viết tiếng Việt — tag cả nhóm một lần (khớp server).
const MENTION_ALL = ['all', 'tất cả', 'tat ca', 'mọi người', 'moi nguoi'];
const MENTION_ALL_LABEL = 'Tất cả';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Regex khớp mọi "@Tên" của thành viên (tên dài ưu tiên trước để "@An Nhiên"
// không bị cắt thành "@An") cộng các dạng @all. Lookahead thay cho \b vì \b
// của JS không biết chữ có dấu ("@tất cả" sẽ không khớp).
function mentionRegex(names: string[], flags = 'giu'): RegExp {
  const alts = [...new Set([...names, ...MENTION_ALL])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe);
  return new RegExp(`@(${alts.join('|')})(?![\\p{L}\\p{N}_])`, flags);
}

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
  // Đang sửa tin nào: id + nội dung gốc (để bỏ qua khi không đổi gì).
  const [editing, setEditing] = useState<{ id: number; original: string } | null>(null);
  // Đang gõ "@..." trong ô soạn: query sau dấu @ và vị trí dấu @ trong text.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvingRef = useRef<Set<string>>(new Set());

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

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

  const mentionRe = useMemo(
    () => mentionRegex((conversation?.participants ?? []).flatMap((p) => [p.display_name ?? '', p.username])),
    [conversation],
  );
  // Tin có nhắc đến mình (hoặc @all) thì bong bóng được tô nổi — regex không
  // có cờ g để .test() không giữ lastIndex giữa các lần gọi.
  const meRe = useMemo(
    () => mentionRegex([user?.display_name ?? '', user?.username ?? ''], 'iu'),
    [user],
  );
  function mentionsMe(body: string): boolean {
    return meRe.test(body);
  }

  // Tách "@Tên" thành span để tô màu; phần còn lại giữ nguyên.
  function renderBody(body: string) {
    const parts: React.ReactNode[] = [];
    let last = 0;
    mentionRe.lastIndex = 0;
    for (let m = mentionRe.exec(body); m; m = mentionRe.exec(body)) {
      if (m.index > last) parts.push(body.slice(last, m.index));
      parts.push(<span key={m.index} className="mention">{m[0]}</span>);
      last = m.index + m[0].length;
    }
    if (last < body.length) parts.push(body.slice(last));
    return parts.length ? parts : body;
  }

  const mentionOptions = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const people = (conversation?.participants ?? [])
      .filter((p) => p.id !== meId)
      .map((p) => ({ id: p.id, name: p.display_name || p.username, avatar: avatarUrl(p.id, p.avatar_at) }));
    const all = conversation?.is_group ? [{ id: 0, name: MENTION_ALL_LABEL, avatar: null }] : [];
    return [...all, ...people].filter((o) => !q || o.name.toLowerCase().includes(q));
  }, [mention, conversation, meId]);

  function updateMention(value: string, caret: number) {
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    setMention(m ? { query: m[1], start: caret - m[1].length - 1 } : null);
  }

  function pickMention(name: string) {
    const input = composerRef.current;
    if (!mention || !input) return;
    const caret = input.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      input.focus();
      const pos = mention.start + name.length + 2;
      input.setSelectionRange(pos, pos);
    });
  }

  function openMentionPicker() {
    const input = composerRef.current;
    const caret = input?.selectionStart ?? text.length;
    const needsSpace = caret > 0 && !/\s/.test(text[caret - 1]);
    const inserted = `${needsSpace ? ' ' : ''}@`;
    const next = text.slice(0, caret) + inserted + text.slice(caret);
    setText(next);
    setMention({ query: '', start: caret + inserted.length - 1 });
    requestAnimationFrame(() => {
      input?.focus();
      const pos = caret + inserted.length;
      input?.setSelectionRange(pos, pos);
    });
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      // Esc đóng popup @ trước; không có popup thì huỷ sửa tin.
      if (mention) setMention(null);
      else if (editing) cancelEdit();
      return;
    }
    if (!mention) return;
    if ((event.key === 'Enter' || event.key === 'Tab') && mentionOptions.length > 0) {
      event.preventDefault();
      pickMention(mentionOptions[0].name);
    }
  }

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

  // Thay tin đã sửa vào state (từ phản hồi PATCH hoặc sự kiện WS) và cập
  // nhật preview ở sidebar nếu đó là tin cuối. Giữ reactions đang có: sự
  // kiện WS mang bản "trung lập" không có cờ mine.
  const applyEdited = useCallback((updated: Message) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === updated.id ? { ...m, ...updated, reactions: m.reactions ?? updated.reactions } : m)),
    );
    setAllConversations((prev) =>
      prev.map((c) => {
        const lm = c.last_message;
        if (c.id !== updated.conversation_id || !lm || lm.id !== updated.id) return c;
        return { ...c, last_message: { ...lm, body: updated.body } };
      }),
    );
  }, []);

  // ---- Thành viên nhóm ----
  const [showMembers, setShowMembers] = useState(false);
  const [memberMode, setMemberMode] = useState<'list' | 'add'>('list');
  const [members, setMembers] = useState<Participant[]>([]);
  const [allUsers, setAllUsers] = useState<Participant[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);
  // Xoá người khác: người tạo nhóm hoặc admin (server kiểm tra lại, 403 not_allowed).
  const canRemoveOthers = !!user?.is_admin || (conversation?.created_by != null && conversation.created_by === meId);
  const candidates = useMemo(
    () => allUsers.filter((u) => !members.some((m) => m.id === u.id)),
    [allUsers, members],
  );
  // Tên nhóm cho hộp xác nhận/thông báo — ref để handler WS bên dưới không
  // phải phụ thuộc vào `conversation` (đỡ mở lại socket mỗi lần meta đổi).
  const groupNameRef = useRef('nhóm');
  groupNameRef.current = conversation?.name ?? 'nhóm';

  // Danh sách mới (từ phản hồi API hoặc sự kiện WS) thay vào cả panel lẫn
  // participants của cuộc trò chuyện (tên/avatar trong bong bóng, @mention,
  // số "👥 N" trên header).
  const applyMembers = useCallback((list: Participant[]) => {
    setMembers(list);
    setConversation((prev) => (prev ? { ...prev, participants: list } : prev));
    setAllConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, participants: list } : c)));
  }, [conversationId]);

  // Dòng hệ thống ("➕ A đã thêm B vào nhóm") trả về cùng phản hồi — mình là
  // người gửi nên WS không đưa lại, tự chèn như tin vừa gửi.
  const appendMessage = useCallback((message: Message) => {
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
  }, []);

  // Ai đó được thêm / rời / bị xoá. Không còn tên mình trong `members` nghĩa
  // là mình vừa ra khỏi nhóm: bỏ nhóm khỏi sidebar và (nếu đang mở) về Home.
  const handleMembersUpdate = useCallback((event: Extract<WsEvent, { type: 'members:update' }>) => {
    const stillIn = event.members.some((m) => m.id === meId);
    if (!stillIn) {
      setAllConversations((prev) => prev.filter((c) => c.id !== event.conversation_id));
      if (event.conversation_id === conversationId) {
        const notice = event.action === 'leave'
          ? `Bạn đã rời nhóm "${groupNameRef.current}"`
          : `Bạn đã bị xoá khỏi nhóm "${groupNameRef.current}"`;
        navigate('/', { replace: true, state: { notice } });
      }
      return;
    }
    if (event.conversation_id === conversationId) {
      applyMembers(event.members);
    } else {
      setAllConversations((prev) =>
        prev.map((c) => (c.id === event.conversation_id ? { ...c, participants: event.members } : c)),
      );
    }
  }, [conversationId, meId, applyMembers, navigate]);

  function memberErrorText(err: unknown): string {
    const code = err instanceof ApiError ? err.message : '';
    switch (code) {
      case 'not_allowed': return 'Chỉ người tạo nhóm hoặc admin mới xoá được thành viên.';
      case 'already_member': return 'Người này đã ở trong nhóm.';
      case 'user_not_found': return 'Không tìm thấy người dùng này.';
      case 'member_not_found': return 'Người này không còn trong nhóm.';
      case 'not_a_member': return 'Bạn không còn trong nhóm này.';
      default: return 'Không thực hiện được, thử lại sau.';
    }
  }

  async function openMembers() {
    setShowMembers(true);
    setMemberMode('list');
    setMemberError(null);
    // Hiện ngay danh sách đang có, rồi làm mới từ server.
    setMembers(conversation?.participants ?? []);
    try {
      applyMembers(await getMembers(conversationId));
    } catch (err) {
      setMemberError(memberErrorText(err));
    }
  }

  function closeMembers() {
    setShowMembers(false);
    setMemberError(null);
  }

  async function openAddMember() {
    setMemberMode('add');
    setMemberError(null);
    setUsersLoading(true);
    try {
      setAllUsers(await getUsers());
    } catch (err) {
      setMemberError(memberErrorText(err));
    } finally {
      setUsersLoading(false);
    }
  }

  async function handleAddMember(candidate: Participant) {
    setMemberBusy(true);
    setMemberError(null);
    try {
      const { members: list, message } = await addMember(conversationId, candidate.id);
      applyMembers(list);
      appendMessage(message);
      setMemberMode('list');
      showNotice(`Đã thêm ${candidate.display_name || candidate.username} vào nhóm`);
    } catch (err) {
      setMemberError(memberErrorText(err));
    } finally {
      setMemberBusy(false);
    }
  }

  async function handleRemoveMember(member: Participant) {
    const name = member.display_name || member.username;
    if (!window.confirm(`Xoá ${name} khỏi nhóm "${groupNameRef.current}"?`)) return;
    setMemberBusy(true);
    setMemberError(null);
    try {
      const { members: list, message } = await removeMember(conversationId, member.id);
      applyMembers(list);
      appendMessage(message);
      showNotice(`Đã xoá ${name} khỏi nhóm`);
    } catch (err) {
      setMemberError(memberErrorText(err));
    } finally {
      setMemberBusy(false);
    }
  }

  async function handleLeave() {
    const name = groupNameRef.current;
    if (!window.confirm(`Rời nhóm "${name}"? Bạn sẽ không nhận tin nhắn của nhóm này nữa.`)) return;
    setMemberBusy(true);
    setMemberError(null);
    try {
      await removeMember(conversationId, meId);
      setShowMembers(false);
      setAllConversations((prev) => prev.filter((c) => c.id !== conversationId));
      navigate('/', { replace: true, state: { notice: `Bạn đã rời nhóm "${name}"` } });
    } catch (err) {
      setMemberError(memberErrorText(err));
      setMemberBusy(false);
    }
  }

  useEffect(() => {
    const conn: WsConnection = connect();
    const offEvent = conn.onEvent((event) => {
      if (event.type === 'message:new' && event.conversation_id === conversationId) {
        setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message]));
      } else if (event.type === 'message:edited') {
        applyEdited(event.message);
      } else if (event.type === 'members:update') {
        handleMembersUpdate(event);
      } else if (event.type === 'conversation:new') {
        // Vừa được thêm vào một nhóm khác (hoặc ai đó mở chat mới với mình):
        // làm mới sidebar.
        loadConversationMeta();
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
  }, [conversationId, loadMessages, loadConversationMeta, applyEdited, handleMembersUpdate]);

  // Đổi cuộc trò chuyện thì bỏ dở việc sửa/trả lời — id tin thuộc cuộc cũ.
  useEffect(() => {
    setEditing(null);
    setReplyTarget(null);
    setMention(null);
    setText('');
  }, [conversationId]);

  // While this is in the future we force-follow the bottom — set on every
  // send so late-loading gifs/stickers can't leave the view stranded above
  // the message that was just sent.
  const followBottomUntil = useRef(0);

  const scrollToBottom = useCallback(() => {
    const list = listRef.current;
    if (!list) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
      return;
    }
    list.scrollTop = list.scrollHeight;
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
  }, []);

  // Late-loading embeds (gifs/stickers) grow the list after the initial
  // scroll — follow the bottom only if the user is already near it.
  const scrollIfNearBottom = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const near = list.scrollHeight - list.scrollTop - list.clientHeight
      < Math.max(320, list.clientHeight * 0.6);
    if (near || Date.now() < followBottomUntil.current) {
      scrollToBottom();
    }
  }, [scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Live reaction updates arrive with neutral counts; recompute my own flag.
  useEffect(() => {
    const conn: WsConnection = connect();
    const off = conn.onEvent((event) => {
      if (event.type !== 'reaction:update') return;
      // Ai đó thả cảm xúc lên tin của mình — nhắc nhỏ dù đang ở chat nào.
      if (event.emoji && event.user_id !== meId && event.message_sender_id === meId) {
        const who = participantNames.get(event.user_id) ?? 'Ai đó';
        showNotice(`${event.emoji} ${who} đã thả cảm xúc tin nhắn của bạn`);
      }
      if (event.conversation_id !== conversationId) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== event.message_id) return m;
          const prevMine = event.user_id === meId
            ? (event.emoji || null)
            : (m.reactions?.find((r) => r.mine)?.emoji ?? null);
          return {
            ...m,
            reactions: event.reactions.map((r) => ({
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
  }, [conversationId, meId, participantNames, showNotice]);


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
    if (editing) cancelEdit();
    const name = participantNames.get(message.sender_id) ?? '';
    const snippet = message.kind === 'image' ? '📷 Photo' : message.kind === 'video' ? '🎥 Video' : (message.body ?? '').slice(0, 90);
    setReplyTarget({ id: message.id, name, snippet });
    composerRef.current?.focus();
  }

  // Đưa nội dung tin của mình vào ô soạn; Enter/Lưu gọi PATCH, Esc/Huỷ thoát.
  function startEdit(message: Message) {
    const original = message.body ?? '';
    setReactingId(null);
    setReplyTarget(null);
    setMention(null);
    setEditing({ id: message.id, original });
    setText(original);
    requestAnimationFrame(() => {
      const input = composerRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(original.length, original.length);
    });
  }

  function cancelEdit() {
    setEditing(null);
    setText('');
    setMention(null);
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
    if (editing) {
      // Không đổi gì thì chỉ thoát chế độ sửa, khỏi gọi server.
      if (body === editing.original.trim()) {
        cancelEdit();
        return;
      }
      setSending(true);
      try {
        const updated = await editMessage(conversationId, editing.id, body);
        applyEdited(updated);
        setEditing(null);
        setText('');
        setMention(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Sửa tin nhắn thất bại');
      } finally {
        setSending(false);
      }
      return;
    }
    setSending(true);
    try {
      followBottomUntil.current = Date.now() + 5000;
      const message = await sendMessage(conversationId, body, replyTarget?.id);
      setMessages((prev) => [...prev, message]);
      setText('');
      setMention(null);
      setReplyTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  async function sendFile(file: File) {
    followBottomUntil.current = Date.now() + 5000;
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
    followBottomUntil.current = Date.now() + 5000;
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
          <a
            className="icon-button farm-link"
            href="/farm/"
            target="_blank"
            rel="noreferrer"
            aria-label="Ăn trộm dzui dzẻ"
            title="Ăn trộm dzui dzẻ"
          >
            🌾
          </a>
          <a
            className="icon-button mahjong-link"
            href="/mahjong/"
            target="_blank"
            rel="noreferrer"
            aria-label="VMahjong"
            title="VMahjong"
          >
            🀄
          </a>
          <a
            className="icon-button blockpuzzle-link"
            href="/blockpuzzle/"
            target="_blank"
            rel="noreferrer"
            aria-label="Xếp Gạch"
            title="Xếp Gạch"
          >
            🧱
          </a>
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
        {conversation?.is_group && (
          <button
            type="button"
            className="icon-button members-btn"
            onClick={openMembers}
            aria-label="Thành viên nhóm"
            title="Thành viên nhóm"
          >
            👥 {conversation.participants.length}
          </button>
        )}
        <a
          className="icon-button farm-link"
          href="/farm/"
          target="_blank"
          rel="noreferrer"
          aria-label="Ăn trộm dzui dzẻ"
          title="Ăn trộm dzui dzẻ"
        >
          🌾
        </a>
        <a
          className="icon-button mahjong-link"
          href="/mahjong/"
          target="_blank"
          rel="noreferrer"
          aria-label="VMahjong"
          title="VMahjong"
        >
          🀄
        </a>
        <a
          className="icon-button blockpuzzle-link"
          href="/blockpuzzle/"
          target="_blank"
          rel="noreferrer"
          aria-label="Xếp Gạch"
          title="Xếp Gạch"
        >
          🧱
        </a>
      </header>

      <div className="message-list" ref={listRef}>
        {loading && <p className="muted-note">Loading messages…</p>}
        {!loading && error && <p className="inline-error">{error}</p>}
        {!loading && messages.length === 0 && !error && (
          <p className="muted-note">No messages yet. Say hi.</p>
        )}
        {messages.map((message) => {
          const isMine = message.sender_id === meId;
          // Người đã rời nhóm không còn trong participants — dùng tên server
          // gắn kèm tin để bong bóng cũ của họ vẫn có tên.
          const senderName = participantNames.get(message.sender_id) ?? message.sender_name ?? undefined;
          const canEdit = isMine && message.kind === 'text' && !isEmbedBody(message.body ?? '');
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
                    {canEdit && (
                      <button type="button" className="react-reply react-edit" onClick={() => startEdit(message)}>
                        ✏️ Sửa
                      </button>
                    )}
                  </div>
                )}
              <div
                className={`bubble${!isMine && message.kind === 'text' && mentionsMe(message.body ?? '') ? ' bubble--mentioned' : ''}`}
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
                    <div className="bubble-text">
                      {renderBody(message.body ?? '')}
                      {!!message.edited_at && <span className="bubble-edited">(đã sửa)</span>}
                    </div>
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
                    // Images in 24h mode (and always one's own) show an
                    // inline thumbnail — the /thumb route doesn't count as
                    // a view. View-once images from others and all videos
                    // keep the tap-to-view chip.
                    message.kind === 'image' && (isMine || message.media_mode === '24h') ? (
                      <button
                        type="button"
                        className="bubble-media-thumb"
                        onClick={() => openMedia(message)}
                        disabled={openingMessageId === message.id}
                        aria-label="View photo"
                      >
                        <img
                          className="bubble-img"
                          src={`/api/media/${message.id}/thumb`}
                          alt=""
                          loading="lazy"
                          onLoad={scrollIfNearBottom}
                        />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="bubble-media-cta"
                        onClick={() => openMedia(message)}
                        disabled={openingMessageId === message.id}
                      >
                        {message.kind === 'video' ? '🎥' : '📷'}{' '}
                        {openingMessageId === message.id ? 'Loading…' : 'Tap to view'}
                      </button>
                    )
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
                {canEdit && (
                  <button type="button" className="bubble-actions-edit" aria-label="Sửa tin nhắn" onClick={() => startEdit(message)}>
                    ✏️ Sửa
                  </button>
                )}
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
      {editing && (
        <div className="reply-strip edit-strip">
          <span className="edit-strip-label">✏️ Đang sửa tin nhắn</span>
          <span className="edit-strip-sep" aria-hidden="true">·</span>
          <button type="button" className="edit-strip-cancel" onClick={cancelEdit}>Huỷ</button>
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
        {/* Không đặt `capture`: có nó, mobile ép mở thẳng camera thay vì cho
            chọn từ thư viện ảnh. Bỏ đi thì iOS/Android hiện đủ lựa chọn
            (Thư viện / Chụp ảnh / Tệp). */}
        <input ref={fileInputRef} type="file" accept="image/*,video/*" hidden onChange={handleFileChange} />
        <button
          type="button"
          className="icon-button mention-btn"
          onClick={openMentionPicker}
          disabled={sending}
          aria-label="Tag tên"
          title="Tag tên (@)"
        >
          @
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => { setShowEmoji((v) => !v); setShowGif(false); setShowMeme(false); }}
          aria-label="Emoji"
        >
          😊
        </button>
        {mention && mentionOptions.length > 0 && (
          <div className="mention-popup" role="listbox">
            {mentionOptions.map((o) => (
              <button key={o.id} type="button" role="option" onMouseDown={(e) => e.preventDefault()} onClick={() => pickMention(o.name)}>
                <span className="mention-popup-avatar">
                  {o.avatar ? <img className="avatar-img" src={o.avatar} alt="" /> : o.id === 0 ? '👥' : o.name.charAt(0).toUpperCase()}
                </span>
                <span className="mention-popup-name">{o.name}</span>
                {o.id === 0 && <span className="mention-popup-hint">cả nhóm</span>}
              </button>
            ))}
          </div>
        )}
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
          onChange={(event) => {
            setText(event.target.value);
            updateMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onKeyDown={handleComposerKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          onPaste={handlePaste}
          placeholder={editing ? 'Sửa tin nhắn…' : 'Message'}
          disabled={sending}
        />
        <button type="submit" disabled={sending || text.trim().length === 0}>
          {editing ? 'Lưu' : 'Send'}
        </button>
      </form>

      {showMembers && (
        <div className="modal-overlay" onClick={closeMembers}>
          <div className="modal members-modal" onClick={(event) => event.stopPropagation()}>
            {memberMode === 'list' ? (
              <>
                <h2>👥 Thành viên · {members.length}</h2>
                <ul className="member-list">
                  {members.map((m) => {
                    const name = m.display_name || m.username;
                    const isMe = m.id === meId;
                    const avatar = avatarUrl(m.id, m.avatar_at);
                    return (
                      <li key={m.id} className="member-row">
                        <span className="member-avatar">
                          {avatar ? <img className="avatar-img" src={avatar} alt="" /> : name.charAt(0).toUpperCase()}
                        </span>
                        <span className="member-body">
                          <span className="member-name">
                            {name}
                            {isMe && <span className="member-hint"> (bạn)</span>}
                          </span>
                          {conversation?.created_by === m.id && <span className="member-hint">Người tạo nhóm</span>}
                        </span>
                        {isMe ? (
                          <button type="button" className="member-leave" onClick={handleLeave} disabled={memberBusy}>
                            Rời nhóm
                          </button>
                        ) : canRemoveOthers && (
                          <button
                            type="button"
                            className="icon-button member-remove"
                            onClick={() => handleRemoveMember(m)}
                            disabled={memberBusy}
                            aria-label={`Xoá ${name} khỏi nhóm`}
                            title="Xoá khỏi nhóm"
                          >
                            ✕
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {memberError && <p className="auth-error">{memberError}</p>}
                <div className="modal-actions">
                  <button type="button" className="secondary-button" onClick={closeMembers}>
                    Đóng
                  </button>
                  <button type="button" className="primary-button" onClick={openAddMember} disabled={memberBusy}>
                    ＋ Thêm
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Thêm thành viên</h2>
                {usersLoading && <p className="muted-note">Đang tải…</p>}
                {!usersLoading && candidates.length === 0 && (
                  <p className="muted-note">Mọi người đều đã ở trong nhóm rồi.</p>
                )}
                <ul className="member-list">
                  {candidates.map((u) => {
                    const name = u.display_name || u.username;
                    const avatar = avatarUrl(u.id, u.avatar_at);
                    return (
                      <li key={u.id} className="member-row">
                        <span className="member-avatar">
                          {avatar ? <img className="avatar-img" src={avatar} alt="" /> : name.charAt(0).toUpperCase()}
                        </span>
                        <span className="member-body">
                          <span className="member-name">{name}</span>
                        </span>
                        <button
                          type="button"
                          className="primary-button member-add"
                          onClick={() => handleAddMember(u)}
                          disabled={memberBusy}
                        >
                          Thêm
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {memberError && <p className="auth-error">{memberError}</p>}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => { setMemberMode('list'); setMemberError(null); }}
                  >
                    ← Quay lại
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
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
      {notice && !viewerError && (
        <div className="toast" onClick={() => setNotice(null)}>
          {notice}
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
