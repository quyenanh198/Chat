import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  createConversation,
  getConversations,
  getStories,
  getUsers,
  postStory,
  type Conversation,
  type Participant,
  type StoryGroup,
} from '../api';
import { useAuth } from '../AuthContext';
import { connect, type WsConnection } from '../ws';

function otherParticipant(conversation: Conversation, meId: number): Participant | undefined {
  return conversation.participants.find((p) => p.id !== meId);
}

function conversationTitle(conversation: Conversation, meId: number): string {
  if (conversation.is_group) return conversation.name ?? 'Group chat';
  const other = otherParticipant(conversation, meId);
  return other ? (other.display_name || other.username) : 'Unknown';
}

function lastMessagePreview(conversation: Conversation): string {
  const message = conversation.last_message;
  if (!message) return 'No messages yet';
  if (message.kind === 'image') return '📷 Photo';
  if (message.kind === 'video') return '🎥 Video';
  return message.body ?? '';
}

function initialLetter(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const meId = user?.id ?? -1;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [storyGroups, setStoryGroups] = useState<StoryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [users, setUsers] = useState<Participant[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [storyUploading, setStoryUploading] = useState(false);
  const [storyError, setStoryError] = useState<string | null>(null);
  const storyFileInputRef = useRef<HTMLInputElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      const list = await getConversations();
      setConversations(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load chats');
    }
  }, []);

  const loadStories = useCallback(async () => {
    try {
      const groups = await getStories();
      setStoryGroups(groups);
    } catch {
      // story ring failing to load isn't fatal to the chat list
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadConversations(), loadStories()]).finally(() => setLoading(false));
  }, [loadConversations, loadStories]);

  useEffect(() => {
    const conn: WsConnection = connect();
    const offEvent = conn.onEvent((event) => {
      if (event.type === 'conversation:new' || event.type === 'message:new') {
        loadConversations();
      }
      if (event.type === 'story:new') {
        loadStories();
      }
    });
    return () => {
      offEvent();
      conn.close();
    };
  }, [loadConversations, loadStories]);

  function openModal() {
    setModalOpen(true);
    setCreateError(null);
    setSelectedIds(new Set());
    setGroupName('');
    setUsersLoading(true);
    getUsers()
      .then(setUsers)
      .catch((err) => setCreateError(err instanceof ApiError ? err.message : 'Failed to load users'))
      .finally(() => setUsersLoading(false));
  }

  function toggleUser(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const isGroupSelection = selectedIds.size > 1;

  async function handleCreate() {
    if (selectedIds.size === 0) return;
    if (isGroupSelection && groupName.trim().length === 0) {
      setCreateError('Group name is required');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const { conversation } = await createConversation(
        [...selectedIds],
        isGroupSelection ? groupName.trim() : undefined,
      );
      setConversations((prev) => {
        const withoutDupe = prev.filter((c) => c.id !== conversation.id);
        return [conversation, ...withoutDupe];
      });
      setModalOpen(false);
      navigate(`/chat/${conversation.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create chat');
    } finally {
      setCreating(false);
    }
  }

  async function handleStoryFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setStoryUploading(true);
    setStoryError(null);
    try {
      await postStory(file);
      await loadStories();
    } catch (err) {
      setStoryError(err instanceof ApiError ? err.message : 'Failed to post story');
    } finally {
      setStoryUploading(false);
    }
  }

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => (b.last_message?.created_at ?? b.created_at) - (a.last_message?.created_at ?? a.created_at)),
    [conversations],
  );

  return (
    <div className="home-page">
      <header className="home-header">
        <h1>Lazybutts</h1>
        <Link to="/settings" className="icon-button" aria-label="Settings">
          ⚙️
        </Link>
      </header>

      <div className="story-ring">
        <button
          type="button"
          className="story-item story-item--add"
          onClick={() => storyFileInputRef.current?.click()}
          disabled={storyUploading}
        >
          <span className="story-avatar story-avatar--add">{storyUploading ? '…' : '📷'}</span>
          <span className="story-label">Add story</span>
        </button>
        <input
          ref={storyFileInputRef}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={handleStoryFileChange}
        />
        {storyGroups.map((group) => {
          const isSelf = group.user.id === meId;
          const hasUnviewed = group.stories.some((s) => !s.viewed);
          return (
            <Link
              key={group.user.id}
              to={`/story/${group.user.id}`}
              className={`story-item${hasUnviewed ? ' story-item--unviewed' : ''}`}
            >
              <span className="story-avatar">{initialLetter(group.user.display_name || group.user.username)}</span>
              <span className="story-label">{isSelf ? 'You' : (group.user.display_name || group.user.username)}</span>
            </Link>
          );
        })}
      </div>
      {storyError && <p className="inline-error">{storyError}</p>}

      <main className="conversation-list">
        {loading && <p className="muted-note">Loading chats…</p>}
        {!loading && error && <p className="inline-error">{error}</p>}
        {!loading && !error && sortedConversations.length === 0 && (
          <p className="muted-note">No chats yet. Tap + to start one.</p>
        )}
        {sortedConversations.map((conversation) => {
          const title = conversationTitle(conversation, meId);
          return (
            <Link key={conversation.id} to={`/chat/${conversation.id}`} className="conversation-row">
              <span className="conversation-avatar">{initialLetter(title)}</span>
              <span className="conversation-body">
                <span className="conversation-title">{title}</span>
                <span className="conversation-preview">{lastMessagePreview(conversation)}</span>
              </span>
            </Link>
          );
        })}
      </main>

      <button type="button" className="fab" onClick={openModal} aria-label="New chat">
        +
      </button>

      {modalOpen && (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>New chat</h2>
            {usersLoading && <p className="muted-note">Loading people…</p>}
            {!usersLoading && users.length === 0 && <p className="muted-note">No other users yet.</p>}
            <ul className="user-picker">
              {users.map((candidate) => (
                <li key={candidate.id}>
                  <label className="user-picker-row">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(candidate.id)}
                      onChange={() => toggleUser(candidate.id)}
                    />
                    {candidate.display_name || candidate.username}
                  </label>
                </li>
              ))}
            </ul>
            {isGroupSelection && (
              <input
                className="group-name-input"
                placeholder="Group name"
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
              />
            )}
            {createError && <p className="auth-error">{createError}</p>}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={handleCreate}
                disabled={creating || selectedIds.size === 0}
              >
                {creating ? 'Creating…' : isGroupSelection ? 'Create group' : 'Start chat'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
