import { randomInt } from 'node:crypto';
import { requireUser } from '../auth.js';

const RESET_TTL_MS = 24 * 60 * 60 * 1000;
// Mã sẽ được đọc qua tin nhắn/điện thoại: bỏ các ký tự dễ nhầm (0/O, 1/I/L).
// 31 ký tự × 10 vị trí ≈ 49 bit — đủ xa tầm đoán khi đã có giới hạn 10 lần/phút,
// hết hạn sau 24 giờ và chỉ dùng được cho đúng một tài khoản.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

export function newResetCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Người dùng gõ lại mã có thể thêm gạch, khoảng trắng hoặc viết thường. */
export function normalizeResetCode(code) {
  return typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

export async function registerPasswordResetRoutes(app) {
  // Chỉ quyenanh198 (config.passwordResetIssuer) phát mã, và phát cho một người cụ thể.
  app.post('/password-resets', { preHandler: requireUser }, async (request, reply) => {
    if (request.user.username !== app.config.passwordResetIssuer) {
      return reply.code(403).send({ error: 'issuer_required' });
    }
    const userId = Number(request.body?.userId);
    const target = Number.isInteger(userId)
      ? app.db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId)
      : null;
    if (!target) {
      return reply.code(404).send({ error: 'user_not_found' });
    }

    const now = Date.now();
    const code = newResetCode();
    app.db.transaction(() => {
      // Mỗi người chỉ một mã còn sống: phát mã mới thì mã cũ (có thể đã gửi nhầm chỗ) hết giá trị.
      app.db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(target.id);
      app.db
        .prepare('INSERT INTO password_resets (code, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(code, target.id, request.user.id, now, now + RESET_TTL_MS);
    })();

    return reply.code(201).send({ code, username: target.username, expiresAt: now + RESET_TTL_MS });
  });
}
