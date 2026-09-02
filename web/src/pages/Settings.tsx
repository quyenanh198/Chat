import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';
import { avatarUrl, uploadAvatar } from '../api';
import AvatarEditor from '../components/AvatarEditor';
import { ApiError, createInvite, logout, updateSettings, type User } from '../api';
import { useAuth } from '../AuthContext';
import { currentPushEndpoint, ensurePushSubscription, isIOS, isStandalone } from '../sw-register';

type NotifState = 'unknown' | 'granted' | 'denied' | 'unsupported';

export default function Settings() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  const [modeError, setModeError] = useState<string | null>(null);
  const [savingMode, setSavingMode] = useState(false);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarDraft, setAvatarDraft] = useState<File | null>(null);

  const [displayName, setDisplayName] = useState(user?.display_name ?? user?.username ?? '');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  const [notifState, setNotifState] = useState<NotifState>('unknown');
  const [enablingNotifs, setEnablingNotifs] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<api.PushStatus | null>(null);
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function refreshPushStatus() {
    try {
      setPushStatus(await api.getPushStatus());
    } catch {
      // status is a nicety; the enable/test buttons still work without it
    }
    setThisEndpoint(await currentPushEndpoint());
  }

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
    setNotifState(Notification.permission === 'granted' ? 'granted' : Notification.permission === 'denied' ? 'denied' : 'unknown');
    void refreshPushStatus();
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

  async function handleAvatarSave(blob: Blob) {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const { user: updated } = await uploadAvatar(blob);
      setUser(updated);
      setAvatarDraft(null);
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
      await refreshPushStatus();
    } catch (err) {
      setNotifState(Notification.permission === 'denied' ? 'denied' : 'unknown');
      setNotifError(err instanceof Error ? err.message : 'Failed to enable notifications');
    } finally {
      setEnablingNotifs(false);
    }
  }

  async function handleTestPush() {
    setTesting(true);
    setTestResult(null);
    try {
      const { sent, results } = await api.sendPushTest();
      const detail = results.map((r) => `${r.host || '?'}: ${r.status || r.error || '?'}`).join(' · ');
      setTestResult(sent > 0
        ? `Đã gửi tới ${sent}/${results.length} thiết bị — kiểm tra màn hình khoá/thanh thông báo nhé. (${detail})`
        : `Không thiết bị nào nhận được. (${detail || 'chưa đăng ký thiết bị nào'})`);
      await refreshPushStatus();
    } catch (err) {
      setTestResult(err instanceof ApiError ? err.message : 'Gửi thử thất bại');
    } finally {
      setTesting(false);
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
            onChange={(e) => { setAvatarDraft(e.target.files?.[0] ?? null); e.target.value = ''; }} />
          <button type="button" className="primary-button" disabled={avatarBusy}
            onClick={() => avatarInputRef.current?.click()}>
            {avatarBusy ? 'Uploading…' : 'Change avatar'}
          </button>
        </div>
        {avatarError && <p className="inline-error">{avatarError}</p>}
        {avatarDraft && (
          <AvatarEditor
            file={avatarDraft}
            busy={avatarBusy}
            onCancel={() => setAvatarDraft(null)}
            onSave={handleAvatarSave}
          />
        )}
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
        <h2>Thông báo</h2>
        {(() => {
          const devices = pushStatus?.devices ?? [];
          const thisDeviceOn = !!thisEndpoint && devices.some((d) => d.endpoint === thisEndpoint);
          const iosTab = isIOS() && !isStandalone();
          return (
            <>
              {notifState === 'unsupported' && iosTab && (
                <p className="inline-error">
                  Trên iPhone/iPad, thông báo chỉ chạy khi cài app vào Màn hình chính: bấm nút Chia sẻ (ô vuông có mũi tên ⬆️) →
                  <b> Thêm vào MH chính</b>, rồi mở Lazybutts từ màn hình chính và bật thông báo ở đây.
                </p>
              )}
              {notifState === 'unsupported' && !iosTab && <p className="muted-note">Trình duyệt này không hỗ trợ thông báo đẩy.</p>}
              {notifState !== 'unsupported' && (
                <p className="muted-note">
                  Thiết bị này: {thisDeviceOn ? '✅ đã bật' : notifState === 'denied' ? '⛔ bị chặn' : '⚠️ chưa bật'}
                  {pushStatus ? ` · Tổng ${devices.length} thiết bị đã đăng ký` : ''}
                </p>
              )}
              {notifState === 'denied' && (
                <p className="inline-error">Thông báo đang bị chặn trong cài đặt trình duyệt — mở cài đặt trang web, cho phép Thông báo rồi bấm lại.</p>
              )}
              {notifState !== 'unsupported' && !thisDeviceOn && (
                <button type="button" className="primary-button" onClick={handleEnableNotifications} disabled={enablingNotifs}>
                  {enablingNotifs ? 'Đang bật…' : '🔔 Bật thông báo trên thiết bị này'}
                </button>
              )}
              {devices.length > 0 && (
                <div className="invite-code-row">
                  <button type="button" className="secondary-button" onClick={handleTestPush} disabled={testing}>
                    {testing ? 'Đang gửi…' : '📨 Gửi thông báo thử'}
                  </button>
                </div>
              )}
              {testResult && <p className="muted-note">{testResult}</p>}
              {notifError && <p className="inline-error">{notifError}</p>}
            </>
          );
        })()}
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
