# Lazybutts MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Spec (nguồn chân lý cho schema/API/rules): `docs/superpowers/specs/2026-08-28-lazybutts-design.md` — implementer PHẢI đọc spec trước khi code.

**Goal:** Chat PWA "Lazybutts" chạy được: Fastify + SQLite backend (auth, chat 1-1/nhóm, media tự hủy theo setting, story 24h, WS, push, cleanup) + React PWA frontend + Dockerfile.

**Tech Stack:** Node 22, Fastify 5, better-sqlite3, jose, argon2, web-push, vitest; React 18 + Vite + TS.

## Global Constraints

- Layout repo: `server/` (Node, ESM, JS thuần) và `web/` (Vite React TS). Mỗi bên package.json riêng.
- Spec là nguồn chân lý: tên bảng/cột, route, shape response, luật tự hủy — không tự chế thêm field.
- Timestamps epoch ms. TDD cho server: viết test trước theo từng task, vitest + app.inject, DB dùng file tạm (mkdtemp) mỗi test, KHÔNG mock SQLite.
- Test cần thời gian trôi: set expires_at trực tiếp trong DB test — không sleep.
- Commit tiếng Anh prefix feat:/fix:/test:/docs:/chore:. Không Co-Authored-By.
- Server code style: ESM, không TypeScript phía server, không ORM, prepared statements.
- KHÔNG thêm dependency ngoài danh sách spec trừ khi thật cần (nêu lý do trong report).

---

### Task 1: Server scaffold + DB + config

**Files:**
- Create: `.gitignore`, `README.md`, `server/package.json`, `server/src/config.js`, `server/src/db.js`, `server/src/schema.sql`, `server/test/helpers.js`, `server/test/db.test.js`

**Interfaces:**
- Produces: `createDb(dataDir)` trả `{db, mediaDir}` — mở SQLite tại `<dataDir>/db/lazybutts.sqlite3` (tự mkdir), WAL, chạy schema.sql idempotent (CREATE TABLE IF NOT EXISTS); `config.js` export `loadConfig(env)` → {port, dataDir, sessionSecret, vapid:{publicKey,privateKey,subject}|null, maxUploadBytes}; throw nếu thiếu SESSION_SECRET. `test/helpers.js` export `makeTestDb()` (mkdtemp + createDb) dùng cho mọi test sau.

- [ ] Viết schema.sql đúng spec (9 bảng). Viết db.test.js: tạo db, insert user, unique username conflict, CHECK media_mode fail với giá trị lạ. Chạy fail → implement db.js/config.js → pass. Commit `feat: server scaffold with sqlite schema and config`.

---

### Task 2: Auth + invites + settings

**Files:**
- Create: `server/src/app.js` (buildApp({config, db, mediaDir}) → Fastify instance, đăng ký cookie + routes), `server/src/auth.js` (hash/verify argon2, sign/verify JWT jose, decorator `requireUser`), `server/src/routes/auth.js`, `server/src/routes/me.js`, `server/src/routes/invites.js`, `server/test/auth.test.js`
- Modify: `server/package.json`

**Interfaces:**
- Produces: buildApp dùng cho mọi test/task sau; cookie `lb_session` httpOnly sameSite lax; `requireUser` gắn `req.user = {id, username, is_admin, media_mode}`; routes theo spec: register (user đầu = admin không cần invite, sau đó bắt buộc invite 1 lần), login, logout, GET /api/me, PATCH /api/me/settings, POST /api/invites (admin, code = 8 hex random).

- [ ] Tests trước: register user đầu thành admin; register thứ 2 không invite → 403; với invite → 201; invite dùng lại → 403; login sai → 401; me trả đúng; settings đổi media_mode '24h' OK rồi giá trị lạ → 400; invites bởi non-admin → 403. Implement → pass. Commit `feat: auth with invites and user settings`.

---

### Task 3: Conversations + text messages

**Files:**
- Create: `server/src/routes/conversations.js`, `server/test/conversations.test.js`
- Modify: `server/src/app.js`

**Interfaces:**
- Produces: POST /api/conversations (dedupe 1-1; group cần name, >=2 user_ids), GET /api/conversations (last_message lọc hết hạn, media chỉ meta), GET/POST /api/conversations/:id/messages (text, expires_at now+24h; lọc expired khi đọc; 403 non-member). Hook `app.notifyNewMessage(conversationId, message)` mặc định no-op (Task 5 gắn WS/push).
- Quyết định đã chốt: `unread_count` trả 0 cố định trong MVP (giá trị thật cần bảng read-state — ngoài scope; giữ field cho FE khỏi vỡ, kèm comment TODO).

- [ ] Tests trước: tạo 1-1 dedupe; group không name → 400; gửi text + đọc lại đúng body/expires; message bị set expires_at quá khứ (update trực tiếp DB) không xuất hiện trong list lẫn last_message; non-member đọc/gửi → 403. Implement → pass. Commit `feat: conversations and expiring text messages`.

---

### Task 4: Media messages + luật tự hủy + stories

**Files:**
- Create: `server/src/media.js` (saveUpload(part, mediaDir) → {path, kind} theo mimetype image/*|video/*, tên file uuid + đuôi theo mimetype, loại khác → 415), `server/src/routes/media.js`, `server/src/routes/stories.js`, `server/test/media.test.js`, `server/test/stories.test.js`
- Modify: `server/src/app.js` (đăng ký multipart limit maxUploadBytes)

**Interfaces:**
- Produces: POST /api/conversations/:id/media (media_mode = setting người gửi lúc gửi); GET /api/media/:messageId — luật spec: mode once → ghi media_views lúc stream, lần 2 → 403 {error:"already_viewed"}, khi TẤT CẢ người nhận (trừ sender) đã xem → unlink file + xóa message; mode 24h → xem tự do; sender xem không ghi view; GET messages kèm cờ `viewable`/`viewed` đúng luật. POST /api/stories, GET /api/stories (nhóm theo user, cờ viewed), GET /api/stories/:id/media (ghi story_views, xem lại được).

- [ ] Tests trước (upload buffer PNG giả 1KB qua form-data): nhóm 3 người, sender mode once: người nhận A xem lần 1 OK, lần 2 403; A+B đều xem xong → file biến khỏi đĩa + message khỏi list; sender đổi setting '24h' → gửi → người nhận xem 3 lần OK; sender tự xem không ghi view; story đăng + list + viewed flag đổi sau khi xem; upload text/plain → 415. Implement → pass. Commit `feat: self-destruct media and 24h stories`.

---

### Task 5: WebSocket + push + cleanup

**Files:**
- Create: `server/src/ws.js` (registry Map userId→Set<socket>; route GET /ws auth qua cookie; `pushToUsers(userIds, event)`), `server/src/push.js` (web-push config từ vapid; `sendPush(userIds, payload)` bỏ qua user đang có WS mở; sub trả 410 thì xóa row; vapid null → tắt êm), `server/src/cleanup.js` (`runCleanup(db, mediaDir)` xóa messages/stories hết hạn + unlink file; `startCleanup` setInterval 60s `.unref()`), `server/src/routes/push.js` (GET /api/push/vapid, POST /api/push/subscribe), `server/src/server.js` (entry: loadConfig → createDb → buildApp → startCleanup → listen 0.0.0.0), `server/test/cleanup.test.js`, `server/test/ws.test.js`
- Modify: `server/src/app.js` (notifyNewMessage → ws broadcast + push; story mới → ws story:new, không push), `server/package.json` (script start)

**Interfaces:**
- Produces: events đúng spec: {type:"message:new", conversation_id, message}, {type:"story:new", user_id, story_id}, {type:"conversation:new", conversation}.

- [ ] Tests trước: runCleanup xóa message/story hết hạn kèm file, giữ thứ còn hạn; WS: app.listen port 0, connect ws client kèm cookie, REST gửi text → client nhận message:new; sendPush với vapid null không throw. Implement → pass. Commit `feat: websocket events, web push, cleanup job`.

---

### Task 6: Frontend scaffold + auth + PWA shell

**Files:**
- Create: `web/package.json`, `web/vite.config.ts` (proxy /api và /ws → http://localhost:8082), `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx` (router + guard: GET /api/me lúc mount, chưa login → /login), `web/src/api.ts` (get/post/patch/upload fetch wrapper credentials:'include' + types User, Conversation, Message, StoryGroup đúng shape spec), `web/src/pages/Login.tsx`, `web/src/pages/Register.tsx` (field invite), `web/src/styles.css` (dark mobile-first), `web/public/manifest.webmanifest` (name "Lazybutts", short_name "Lazybutts", display standalone, theme #0f172a, icon SVG purpose any), `web/public/icon.svg` (chữ LB trên nền tròn tối — vẽ tay SVG), `web/public/sw.js` (install cache shell; push → showNotification(payload.title, {body, data.url}); notificationclick → focus hoặc openWindow), `web/src/sw-register.ts`

- [ ] Verify: `npm run build` + `npx tsc --noEmit` sạch. Commit `feat: web scaffold with auth pages and pwa shell`.

---

### Task 7: Frontend chats + media + stories + settings

**Files:**
- Create: `web/src/pages/Home.tsx` (story ring ngang trên đầu + chat list + nút mở modal chat mới: chọn 1 user = 1-1, nhiều user + tên = nhóm), `web/src/pages/Chat.tsx` (list bubble, WS live + refetch khi mở, composer: input text + nút 📷 `<input type=file accept="image/*,video/*" capture>`, media bubble "Tap to view" → viewer overlay full màn (img/video), view-once đã xem hiện "Opened" mờ), `web/src/pages/Story.tsx` (viewer: tự chuyển ảnh 5s/video hết thì next, tap next, đóng khi hết), `web/src/pages/Settings.tsx` (toggle once/24h gọi PATCH settings, nút logout, nếu admin: nút "Tạo invite" hiện code copy được; nút bật notification → đăng ký push sub), `web/src/ws.ts` (reconnecting websocket, callback theo type)
- Modify: `web/src/App.tsx`, `web/src/styles.css`

- [ ] Verify: build + tsc sạch. Commit `feat: chat, story, settings ui`.

---

### Task 8: Dockerfile + smoke test + docs

**Files:**
- Create: `Dockerfile` (stage builder-web: node:22-slim, build web; stage runtime: node:22-slim, copy server/ + npm ci --omit=dev + web/dist; ENV PORT=8082 DATA_DIR=/data; EXPOSE 8082; CMD ["node","server/src/server.js"]; server serve web/dist qua @fastify/static, fallback không-phải-/api → index.html), `.dockerignore`, `scripts/smoke.sh` (bash: DATA_DIR=$(mktemp -d) SESSION_SECRET=test node server & đợi port; curl cookie-jar: register → me → tạo 2 user + chat 1-1 → gửi text → đọc thấy đúng body; kill server; exit theo kết quả)
- Modify: `server/src/app.js` hoặc `server.js` (static serving khi web/dist tồn tại), `README.md` (env, dev, build, sinh VAPID `npx web-push generate-vapid-keys`, cách nối vào hub: submodule apps/chat, thêm env vào compose)

- [ ] Verify: `bash scripts/smoke.sh` pass; `npm test` server xanh toàn bộ; web build sạch. Commit `feat: dockerfile, smoke test, docs`.
