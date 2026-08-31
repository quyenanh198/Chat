import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';
import { avatarUrl, uploadAvatar } from '../api';
import { ApiError, createInvite, logout, updateSettings, type User } from '../api';
import { useAuth } from '../AuthContext';
import { ensurePushSubscription } from '../sw-register';

type NotifState = 'unknown' | 'granted' | 'denied' | 'unsupported';

export default function Settings() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  const [modeError, setModeError] = useState<string | null>(null);
  const [savingMode, setSavingMode] = useState(false);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState(user?.display_name ?? user?.username ?? '');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  const [notifState, setNotifState] = useState<NotifState>('unknown');
  const [enablingNotifs, setEnablingNotifs] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);

  const [loggingOut, setLoggingOut] = useState(false);

  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setNotifState('unsupported');
      return;
    }
    setNotifState(Notification.permission === 'granted' ? 'granted' : 'unknown');
  }, []);

  if (!user) return null;

  async function handleModeChange(mode: User['media_mode']) {
    if (!user || mode === user.media_mode || savingMode) return;
    const previous = user.media_mode;
    setModeError(null);
    setUser({ ...user, media_mode: mode }); // optimistic
    setSavingMode(true);
    try {
      const { user: updated } = await updateSettings(mode);
      setUser(updated);
    } catch (err) {
      setUser({ ...user, media_mode: previous });
      setModeError(err instanceof ApiError ? err.message : 'Failed to update setting');
    } finally {
      setSavingMode(false);
    }
  }

  async function handleAvatarPick(file: File | undefined) {
    if (!file) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const { user: updated } = await uploadAvatar(file);
      setUser(updated);
    } catch (err) {
      setAvatarError(err instanceof ApiError ? err.message : 'Failed to upload avatar');
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleSaveDisplayName() {
    setSavingName(true);
    setNameError(null);
    setNameSaved(false);
    try {
      const { user: updated } = await api.updateProfile(displayName);
      setUser(updated);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 3000);
    } catch (err) {
      setNameError(err instanceof ApiError ? err.message : 'Failed to save name');
    } finally {
      setSavingName(false);
    }
  }

  async function handleEnableNotifications() {
    setEnablingNotifs(true);
    setNotifError(null);
    try {
      const subscription = await ensurePushSubscription(api);
      setNotifState(subscription ? 'granted' : 'unsupported');
    } catch (err) {
      setNotifState(Notification.permission === 'denied' ? 'denied' : 'unknown');
      setNotifError(err instanceof Error ? err.message : 'Failed to enable notifications');
    } finally {
      setEnablingNotifs(false);
    }
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      // fall through to clearing local session state regardless
    }
    setUser(null);
    navigate('/login', { replace: true });
  }

  async function handleGenerateInvite() {
    setGeneratingInvite(true);
    setInviteError(null);
    setCopied(false);
    try {
      const { code } = await createInvite();
      setInviteCode(code);
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : 'Failed to generate invite');
    } finally {
      setGeneratingInvite(false);
    }
  }

  async function handleCopyInvite() {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
    } catch {
      setInviteError('Copy failed — copy the code manually');
    }
  }

  return (
    <div className="settings-page">
      <header className="chat-header">
        <button type="button" className="icon-button" onClick={() => navigate('/')} aria-label="Back">
          ←
        </button>
        <h1>Settings</h1>
      </header>

      <section className="settings-section">
        <h2>Avatar</h2>
        <div className="invite-code-row">
          <span className="conversation-avatar">
            {avatarUrl(user.id, user.avatar_at)
              ? <img className="avatar-img" src={avatarUrl(user.id, user.avatar_at)!} alt="" />
              : (user.display_name || user.username).charAt(0).toUpperCase()}
          </span>
          <input ref={avatarInputRef} type="file" accept="image/*" hidden
            onChange={(e) => handleAvatarPick(e.target.files?.[0])} />
          <button type="button" className="primary-button" disabled={avatarBusy}
            onClick={() => avatarInputRef.current?.click()}>
            {avatarBusy ? 'Uploading…' : 'Change avatar'}
          </button>
        </div>
        {avatarError && <p className="inline-error">{avatarError}</p>}
      </section>

      <section className="settings-section">
        <h2>Display name</h2>
        <p className="muted-note">Shown to others in chats and stories. Your login username ({user.username}) stays the same.</p>
        <div className="invite-code-row">
          <input
            className="group-name-input"
            value={displayName}
            maxLength={40}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={user.username}
          />
          <button type="button" className="primary-button" onClick={handleSaveDisplayName} disabled={savingName}>
            {savingName ? 'Saving…' : nameSaved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
        {nameError && <p className="inline-error">{nameError}</p>}
      </section>

      <section className="settings-section">
        <h2>Media default</h2>
        <p className="muted-note">How long people can view photos/videos you send.</p>
        <div className="mode-toggle">
          <button
            type="button"
            className={`mode-option${user.media_mode === 'once' ? ' mode-option--active' : ''}`}
            onClick={() => handleModeChange('once')}
            disabled={savingMode}
          >
            View once
          </button>
          <button
            type="button"
            className={`mode-option${user.media_mode === '24h' ? ' mode-option--active' : ''}`}
            onClick={() => handleModeChange('24h')}
            disabled={savingMode}
          >
            24 hours
          </button>
        </div>
        {modeError && <p className="inline-error">{modeError}</p>}
      </section>

      <section className="settings-section">
        <h2>Notifications</h2>
        {notifState === 'granted' && <p className="muted-note">Notifications are enabled.</p>}
        {notifState === 'denied' && (
          <p className="inline-error">Notifications are blocked in your browser settings.</p>
        )}
        {notifState === 'unsupported' && <p className="muted-note">Push isn't supported on this browser.</p>}
        {(notifState === 'unknown' || notifState === 'denied') && (
          <button type="button" className="primary-button" onClick={handleEnableNotifications} disabled={enablingNotifs}>
            {enablingNotifs ? 'Enabling…' : 'Enable notifications'}
          </button>
        )}
        {notifError && <p className="inline-error">{notifError}</p>}
      </section>

      {user.is_admin && (
        <section className="settings-section">
          <h2>Invites</h2>
          <button type="button" className="primary-button" onClick={handleGenerateInvite} disabled={generatingInvite}>
            {generatingInvite ? 'Generating…' : 'Generate invite'}
          </button>
          {inviteCode && (
            <div className="invite-code-row">
              <code className="invite-code">{inviteCode}</code>
              <button type="button" className="secondary-button" onClick={handleCopyInvite}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          )}
          {inviteError && <p className="inline-error">{inviteError}</p>}
        </section>
      )}

      <section className="settings-section">
        <button type="button" className="danger-button" onClick={handleLogout} disabled={loggingOut}>
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
      </section>
    </div>
  );
}
