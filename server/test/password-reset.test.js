import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeTestDb } from './helpers.js';

function extractSessionCookie(response) {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const session = cookies.find((c) => c.startsWith('lb_session='));
  return session ? session.split(';')[0] : null;
}

// Người đầu tiên đăng ký là admin; đặt tên đúng quyenanh198 để khớp người phát mã mặc định.
async function setup() {
  const { db, mediaDir } = makeTestDb();
  const app = buildApp({ config: loadConfig({ SESSION_SECRET: 'test-secret' }), db, mediaDir, logger: false });
  const post = (url, payload, cookie) =>
    app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });

  const admin = extractSessionCookie(await post('/api/auth/register', { username: 'quyenanh198', password: 'admin-password-1' }));
  const invite = async () => (await post('/api/invites', {}, admin)).json().code;
  const join = async (username) => {
    const res = await post('/api/auth/register', { username, password: 'old-password-123', invite: await invite() });
    return { id: res.json().user.id, cookie: extractSessionCookie(res) };
  };
  const bo = await join('bo_ca_rot');
  const me = await join('me_bap');
  const issue = (userId, cookie = admin) => post('/api/password-resets', { userId }, cookie);
  const reset = (username, code, password = 'new-password-456') =>
    post('/api/auth/reset-password', { username, code, password });
  const login = (username, password) => post('/api/auth/login', { username, password });
  const whoAmI = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { app, db, admin, bo, me, invite, issue, reset, login, whoAmI };
}

describe('mã khôi phục mật khẩu', () => {
  it('chỉ quyenanh198 phát được mã', async () => {
    const { bo, me, issue } = await setup();
    expect((await issue(me.id, bo.cookie)).statusCode).toBe(403);
    const ok = await issue(bo.id);
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ username: 'bo_ca_rot' });
    expect(ok.json().code).toMatch(/^[A-Z2-9]{10}$/);
  });

  it('đặt lại xong thì đăng nhập bằng mật khẩu mới, mật khẩu cũ hết dùng được', async () => {
    const { bo, issue, reset, login, whoAmI } = await setup();
    const { code } = (await issue(bo.id)).json();

    const res = await reset('bo_ca_rot', code);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('bo_ca_rot');
    // Được đăng nhập luôn bằng phiên mới.
    expect((await whoAmI(extractSessionCookie(res))).statusCode).toBe(200);

    expect((await login('bo_ca_rot', 'new-password-456')).statusCode).toBe(200);
    expect((await login('bo_ca_rot', 'old-password-123')).statusCode).toBe(401);
  });

  it('thu hồi mọi phiên cũ của tài khoản đó, không đụng tới người khác', async () => {
    const { bo, me, issue, reset, whoAmI } = await setup();
    expect((await whoAmI(bo.cookie)).statusCode).toBe(200);
    const { code } = (await issue(bo.id)).json();
    // Phiên cũ phải có iat trước mốc đổi mật khẩu (tính theo giây).
    await new Promise((r) => setTimeout(r, 1100));
    await reset('bo_ca_rot', code);
    expect((await whoAmI(bo.cookie)).statusCode).toBe(401);
    expect((await whoAmI(me.cookie)).statusCode).toBe(200);
  });

  it('mã của người này không mở được tài khoản người khác', async () => {
    const { bo, issue, reset, login } = await setup();
    const { code } = (await issue(bo.id)).json();
    const res = await reset('me_bap', code);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('invalid_reset');
    expect((await login('me_bap', 'old-password-123')).statusCode).toBe(200);
  });

  it('mã mời đăng ký không dùng để đặt lại mật khẩu được', async () => {
    const { invite, reset } = await setup();
    const res = await reset('bo_ca_rot', await invite());
    expect(res.statusCode).toBe(403);
  });

  it('mỗi mã dùng một lần', async () => {
    const { bo, issue, reset } = await setup();
    const { code } = (await issue(bo.id)).json();
    expect((await reset('bo_ca_rot', code)).statusCode).toBe(200);
    expect((await reset('bo_ca_rot', code, 'another-password-789')).statusCode).toBe(403);
  });

  it('mã hết hạn sau 24 giờ', async () => {
    const { db, bo, issue, reset } = await setup();
    const { code } = (await issue(bo.id)).json();
    db.prepare('UPDATE password_resets SET expires_at = ? WHERE code = ?').run(Date.now() - 1, code);
    expect((await reset('bo_ca_rot', code)).statusCode).toBe(403);
  });

  it('phát mã mới thì mã cũ hết giá trị', async () => {
    const { bo, issue, reset } = await setup();
    const first = (await issue(bo.id)).json().code;
    const second = (await issue(bo.id)).json().code;
    expect((await reset('bo_ca_rot', first)).statusCode).toBe(403);
    expect((await reset('bo_ca_rot', second)).statusCode).toBe(200);
  });

  it('gõ mã có gạch, khoảng trắng hay chữ thường vẫn nhận', async () => {
    const { bo, issue, reset } = await setup();
    const { code } = (await issue(bo.id)).json();
    const typed = `${code.slice(0, 5)}- ${code.slice(5)}`.toLowerCase();
    expect((await reset('bo_ca_rot', typed)).statusCode).toBe(200);
  });

  it('mật khẩu mới phải đủ 12 ký tự, và kiểm tra trước khi tiêu mã', async () => {
    const { bo, issue, reset } = await setup();
    const { code } = (await issue(bo.id)).json();
    expect((await reset('bo_ca_rot', code, 'short')).statusCode).toBe(400);
    expect((await reset('bo_ca_rot', code)).statusCode).toBe(200);
  });

  it('người không tồn tại và mã sai trả cùng một lỗi', async () => {
    const { reset } = await setup();
    const ghost = await reset('khong_ai_ca', 'ABCDEFGHJK');
    expect(ghost.statusCode).toBe(403);
    expect(ghost.json().error).toBe('invalid_reset');
  });
});
