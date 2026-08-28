# Lazybutts — Design (chat PWA tự hủy, chạy trên Mac Mini hub)

Ngày: 2026-08-28
Trạng thái: Đã duyệt

## Mục đích

Chat app kiểu Snapchat cho gia đình/bạn bè, self-host trong stack macmini-hub. Image `ghcr.io/quyenanh198/chat`, port nội bộ 8082, DB tại `/data/db`, media tại `/data/media` (compose hub mount sẵn từ ổ ngoài). Subdomain chat bypass Cloudflare Access — app tự quản auth.

## Stack

- Backend: Node 22, Fastify 5, @fastify/websocket, @fastify/cookie, @fastify/multipart, better-sqlite3, web-push, argon2, JWT (jose). Tests: vitest + fastify inject.
- Frontend: React 18 + Vite + TypeScript, React Router, CSS thuần (dark, mobile-first). PWA: manifest.webmanifest tên "Lazybutts" + service worker tự viết (push, notificationclick, cache shell).
- Đóng gói: Dockerfile multi-stage — build web, Fastify serve static + API. Một container duy nhất.

## Quy tắc tự hủy

- Text: hết hạn 24h kể từ lúc gửi.
- Media (ảnh/video): theo **setting per-user** của NGƯỜI GỬI tại thời điểm gửi — `once` (xem 1 lần) hoặc `24h`. Đổi trong Settings, lưu DB, mặc định `once`.
  - `once`: mỗi người nhận xem được đúng 1 lần (xem lần 2 bị 403); file + message xóa khi TẤT CẢ người nhận (trừ người gửi) đã xem, hoặc chạm mốc 24h — cái nào trước.
  - `24h`: xem thoải mái trong 24h rồi xóa.
- Story: 24h, mọi user trong app đều thấy, xem nhiều lần được, có đánh dấu đã xem.
- Cleanup job trong server chạy mỗi 60s: xóa row hết hạn + unlink file tương ứng.
- Upload cap 50MB. Người gửi luôn xem lại được media của chính mình cho tới khi hết hạn (không tính lượt view-once).

## Dữ liệu (SQLite, WAL mode)

```sql
users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      media_mode TEXT NOT NULL DEFAULT 'once' CHECK(media_mode IN ('once','24h')),
      created_at INTEGER NOT NULL);
invites(code TEXT PRIMARY KEY, created_by INTEGER NOT NULL, used_by INTEGER,
        created_at INTEGER NOT NULL);
conversations(id INTEGER PRIMARY KEY, is_group INTEGER NOT NULL DEFAULT 0, name TEXT,
              created_at INTEGER NOT NULL);
participants(conversation_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
             joined_at INTEGER NOT NULL, PRIMARY KEY(conversation_id, user_id));
messages(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, sender_id INTEGER NOT NULL,
         kind TEXT NOT NULL CHECK(kind IN ('text','image','video')),
         body TEXT, media_path TEXT, media_mode TEXT CHECK(media_mode IN ('once','24h')),
         created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
media_views(message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, viewed_at INTEGER NOT NULL,
            PRIMARY KEY(message_id, user_id));
stories(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('image','video')),
        media_path TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
story_views(story_id INTEGER NOT NULL, user_id INTEGER NOT NULL, viewed_at INTEGER NOT NULL,
            PRIMARY KEY(story_id, user_id));
push_subs(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL,
          p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
```

Timestamps: epoch ms (INTEGER). Auth stateless JWT (cookie httpOnly `lb_session`, HS256, secret env), không bảng session. User đầu tiên đăng ký tự thành admin và KHÔNG cần invite; từ user thứ 2 bắt buộc invite code (dùng 1 lần).

## Env

`PORT` (default 8082), `DATA_DIR` (default /data — DB tại $DATA_DIR/db/lazybutts.sqlite3, media tại $DATA_DIR/media), `SESSION_SECRET` (bắt buộc), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto:), `MAX_UPLOAD_MB` (default 50).

## API (prefix /api)

- POST /auth/register {username, password, invite?} → 201 {user}; set cookie. User đầu không cần invite.
- POST /auth/login {username, password} → {user}; set cookie. 401 sai.
- POST /auth/logout → clear cookie.
- GET /me → {id, username, is_admin, media_mode}
- PATCH /me/settings {media_mode} → {user}
- POST /invites (admin only) → {code}
- GET /users → [{id, username}] (trừ chính mình)
- POST /conversations {user_ids: number[], name?} → conversation; 1-1 (1 user_id, không name) dedupe: trả conversation cũ nếu đã có.
- GET /conversations → [{id, is_group, name, participants, last_message (đã lọc hết hạn, media chỉ meta), unread_count}]
- GET /conversations/:id/messages → messages chưa hết hạn, cũ→mới; mỗi media message kèm `viewable` (theo luật once/24h với user hiện tại) và `viewed`.
- POST /conversations/:id/messages {body} → message kind text, expires_at = now+24h.
- POST /conversations/:id/media (multipart file) → message kind image|video (theo mimetype), media_mode = setting hiện tại của người gửi, expires_at = now+24h.
- GET /media/:messageId → stream file nếu được phép; với mode once: ghi media_views lúc trả, lần 2 → 403 {error:"already_viewed"}; sau khi TẤT CẢ người nhận xem → unlink file + xóa message. Người gửi xem không ghi view.
- POST /stories (multipart) → story, expires_at = now+24h.
- GET /stories → nhóm theo user: [{user:{id,username}, stories:[{id,kind,created_at,viewed}]}]
- GET /stories/:id/media → stream + ghi story_views (xem lại được).
- GET /push/vapid → {publicKey}
- POST /push/subscribe {subscription} → 201 (upsert theo endpoint).
- GET /ws (WebSocket, auth qua cookie) — server đẩy: {type:"message:new", conversation_id, message}, {type:"story:new", user_id, story_id}, {type:"conversation:new", conversation}. Gửi tin qua REST, không qua WS.

Mọi route trừ auth/register, auth/login, push/vapid yêu cầu đăng nhập (401 nếu không). 403 nếu đụng conversation không phải thành viên.

## Push

Khi message:new — gửi web-push tới participant KHÔNG có WS đang mở (title tên người gửi, body "📷 Photo"/"🎥 Video"/text rút gọn, click mở app). Story mới: không push (đỡ ồn). Sub hết hạn (410) thì xóa row.

## Frontend (routes)

`/login`, `/register` (nhập invite), `/` = danh sách chat + story ring trên đầu, `/chat/:id` (bong bóng tin, composer: text + nút camera/file; media hiện placeholder "Tap to view" mở viewer, view-once đã xem hiện "Opened"), `/story/:userId` (viewer tự chạy, tap chuyển), `/settings` (media_mode toggle, logout; admin: nút sinh invite + hiện code). PWA: cài được lên home screen, sw đăng ký push, xin quyền notification sau đăng nhập.

## Ngoài phạm vi MVP

E2EE, call, filter, reactions, typing indicator, đổi mật khẩu, xóa account, đổi tên nhóm sau tạo.

## Kiểm chứng thành công

- `npm test` (server) xanh: auth + invite, expiry text 24h, luật once (xem 2 lần 403, đủ người xem thì file biến mất), luật 24h, settings đổi mode, quyền conversation.
- `npm run build` (web) + `tsc --noEmit` sạch.
- Server chạy local, curl smoke: register → login → tạo chat → gửi text → đọc lại.
- Docker build được image arm64 (trên CI, khi thành submodule của hub).
