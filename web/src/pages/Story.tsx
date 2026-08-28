import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, getStories, type Participant, type StoryFeedItem } from '../api';
import { fetchMediaBlobUrl } from '../mediaBlob';

const IMAGE_DURATION_MS = 5000;

export default function Story() {
  const { userId } = useParams<{ userId: string }>();
  const targetUserId = Number(userId);
  const navigate = useNavigate();

  const [storyUser, setStoryUser] = useState<Participant | null>(null);
  const [stories, setStories] = useState<StoryFeedItem[]>([]);
  const [index, setIndex] = useState(0);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function close() {
    navigate('/');
  }

  function goNext() {
    if (index + 1 >= stories.length) {
      close();
      return;
    }
    setIndex(index + 1);
  }

  function goPrev() {
    if (index > 0) setIndex(index - 1);
  }

  // Load the story group for this user once on mount / when the route param
  // changes (tapping between story rings navigates here again).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStories()
      .then((groups) => {
        if (cancelled) return;
        const group = groups.find((g) => g.user.id === targetUserId);
        if (!group || group.stories.length === 0) {
          setError('No stories to show');
          setStories([]);
          setStoryUser(null);
          return;
        }
        setStoryUser(group.user);
        setStories(group.stories);
        setIndex(0);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load stories');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  const current = stories[index];

  // Fetch the current story's media as a blob URL, revoking the previous one.
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setMediaUrl(null);
    fetchMediaBlobUrl(`/api/stories/${current.id}/media`)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setMediaUrl(url);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load story');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Auto-advance timer for images; videos advance from their own onEnded.
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!current || !mediaUrl || current.kind !== 'image') return;
    timerRef.current = setTimeout(() => {
      goNext();
    }, IMAGE_DURATION_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, mediaUrl]);

  if (loading) {
    return <div className="story-viewer story-viewer--empty">Loading…</div>;
  }

  if (error || !current || !storyUser) {
    return (
      <div className="story-viewer story-viewer--empty">
        <p>{error ?? 'No stories to show'}</p>
        <button type="button" className="primary-button" onClick={close}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="story-viewer">
      <div className="story-progress-bar">
        {stories.map((s, i) => (
          <div key={s.id} className="story-progress-seg">
            <div
              className={`story-progress-fill${i < index ? ' story-progress-fill--full' : ''}${
                i === index ? ' story-progress-fill--active' : ''
              }`}
              style={i === index && current.kind === 'image' ? { animationDuration: `${IMAGE_DURATION_MS}ms` } : undefined}
            />
          </div>
        ))}
      </div>

      <div className="story-header">
        <span className="story-header-name">{storyUser.username}</span>
        <button type="button" className="story-close" onClick={close} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="story-media">
        {mediaUrl && current.kind === 'video' && (
          <video key={current.id} src={mediaUrl} autoPlay playsInline onEnded={goNext} />
        )}
        {mediaUrl && current.kind === 'image' && <img src={mediaUrl} alt="" />}
      </div>

      <div className="story-tap-zones">
        <div className="story-tap-zone story-tap-zone--prev" onClick={goPrev} />
        <div className="story-tap-zone story-tap-zone--next" onClick={goNext} />
      </div>
    </div>
  );
}
