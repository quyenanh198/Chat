import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, resetPassword } from '../api';
import { useAuth } from '../AuthContext';

// Lỗi server trả mã, người dùng cần câu dễ hiểu. `invalid_reset` gộp mọi kiểu sai (tên,
// mã, mã của người khác, hết hạn, đã dùng) — server cố ý không nói rõ là sai chỗ nào.
const MESSAGES: Record<string, string> = {
  invalid_reset: 'Tên đăng nhập hoặc mã khôi phục không đúng, hoặc mã đã hết hạn / đã dùng. Nhắn quyenanh198 xin mã mới.',
  password_too_short: 'Mật khẩu mới cần ít nhất 12 ký tự.',
  username_code_and_password_required: 'Điền đủ cả ba ô.',
};
const MIN_PASSWORD_LENGTH = 12;

export default function ResetPassword() {
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const { setUser } = useAuth();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    // Kiểm tra ngay trên máy để khỏi tốn một lượt thử (server giới hạn 10 lần/phút).
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(MESSAGES.password_too_short);
      return;
    }
    if (password !== confirm) {
      setError('Hai lần nhập mật khẩu mới không giống nhau.');
      return;
    }
    setSubmitting(true);
    try {
      const { user } = await resetPassword(username.trim(), code, password);
      setUser(user);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError('Thử quá nhiều lần. Đợi một phút rồi thử lại.');
      else setError(err instanceof ApiError ? (MESSAGES[err.message] ?? err.message) : 'Không đặt lại được mật khẩu.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Quên mật khẩu</h1>
        <p className="auth-hint">
          Nhắn <b>quyenanh198</b> xin <b>mã khôi phục</b> cho tài khoản của bạn. Mã chỉ dùng được một lần, trong
          24 giờ, và chỉ cho đúng tài khoản đó. Đặt lại xong, mọi máy đang đăng nhập tài khoản này sẽ bị đăng xuất.
        </p>
        <label>
          Tên đăng nhập
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
          />
        </label>
        <label>
          Mã khôi phục
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="VD: K7MQ2-XR9TA"
            required
          />
        </label>
        <label>
          Mật khẩu mới
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
        </label>
        <label>
          Nhập lại mật khẩu mới
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Đang đặt lại…' : 'Đặt lại mật khẩu'}
        </button>
        <p className="auth-switch">
          Nhớ ra rồi? <Link to="/login">Đăng nhập</Link>
        </p>
      </form>
    </div>
  );
}
