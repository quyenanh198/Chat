#!/usr/bin/env bash
# Smoke test for the Lazybutts server: boots a real server against a
# throwaway sqlite DB, exercises the core happy path over HTTP exactly like
# a real client would (register -> invite -> register second user -> 1-1
# conversation -> send text -> read it back), and — when the web app has
# been built — checks that GET / serves the SPA shell.
#
# Usage: bash scripts/smoke.sh   (run from anywhere; paths are resolved
# relative to this script's location, i.e. the repo root's scripts/ dir)
#
# Exit 0 only if every check below passes.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-18082}"
BASE="http://127.0.0.1:${PORT}"
DATA_DIR="$(mktemp -d)"
JAR_ADMIN="$(mktemp)"
JAR_USER2="$(mktemp)"
SERVER_PID=""

step() { echo; echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# Pulls one dotted field (e.g. "user.id") out of a JSON blob on stdin.
# Uses node (already a hard dependency of this project) instead of jq so the
# script doesn't need anything beyond what running the server itself needs.
json_get() {
  node -e '
    let data = "";
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => {
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        process.stderr.write("json_get: invalid JSON: " + data + "\n");
        process.exit(1);
      }
      const value = process.argv[1].split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
      process.stdout.write(String(value));
    });
  ' "$1"
}

# Issues one request through a cookie jar and prints "<body>\n<http_code>".
http() {
  local method="$1" url="$2" jar="$3" data="${4:-}"
  if [[ -n "$data" ]]; then
    curl -s -w '\n%{http_code}' -c "$jar" -b "$jar" -X "$method" "$url" \
      -H 'Content-Type: application/json' -d "$data"
  else
    curl -s -w '\n%{http_code}' -c "$jar" -b "$jar" -X "$method" "$url"
  fi
}

body_of() { sed '$d' <<<"$1"; }
code_of() { tail -n1 <<<"$1"; }

cleanup() {
  local status=$?
  step "cleanup"
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    echo "server (pid $SERVER_PID) stopped"
  fi
  if rm -rf "$DATA_DIR" 2>/dev/null; then
    echo "removed temp data dir $DATA_DIR"
  else
    echo "NOTE: could not remove temp data dir $DATA_DIR (env may block rm) - skipping, not fatal"
  fi
  rm -f "$JAR_ADMIN" "$JAR_USER2" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

step "starting server (DATA_DIR=$DATA_DIR, PORT=$PORT)"
DATA_DIR="$DATA_DIR" SESSION_SECRET="smoketest" PORT="$PORT" \
  node "$ROOT_DIR/server/src/server.js" &
SERVER_PID=$!

step "waiting for server to accept connections"
ready=0
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "$BASE/api/me"; then
    ready=1
    break
  fi
  sleep 0.5
done
[[ "$ready" == "1" ]] || fail "server did not come up on $BASE after 10s"
# Guard against a false "ready": if $PORT was already occupied by some other
# process, our node invocation above would have exited immediately on
# EADDRINUSE while curl still happily talked to that other process. Confirm
# it's actually *our* process still alive before trusting anything it says.
kill -0 "$SERVER_PID" 2>/dev/null || fail "port $PORT was already in use by another process (our server (pid $SERVER_PID) exited immediately)"
echo "server is up"

step "register admin (first user, no invite needed, becomes admin)"
RESP=$(http POST "$BASE/api/auth/register" "$JAR_ADMIN" '{"username":"admin","password":"smoke-test-pass-1"}')
[[ "$(code_of "$RESP")" == "201" ]] || fail "register admin expected 201, got $(code_of "$RESP"): $(body_of "$RESP")"
ADMIN_IS_ADMIN=$(body_of "$RESP" | json_get user.is_admin)
[[ "$ADMIN_IS_ADMIN" == "true" ]] || fail "first registered user should be admin, got is_admin=$ADMIN_IS_ADMIN"

step "GET /api/me as admin"
RESP=$(http GET "$BASE/api/me" "$JAR_ADMIN")
[[ "$(code_of "$RESP")" == "200" ]] || fail "GET /api/me expected 200, got $(code_of "$RESP"): $(body_of "$RESP")"
ME_USERNAME=$(body_of "$RESP" | json_get username)
[[ "$ME_USERNAME" == "admin" ]] || fail "GET /api/me returned unexpected username: $ME_USERNAME"

step "admin creates an invite"
RESP=$(http POST "$BASE/api/invites" "$JAR_ADMIN")
[[ "$(code_of "$RESP")" == "201" ]] || fail "POST /api/invites expected 201, got $(code_of "$RESP"): $(body_of "$RESP")"
INVITE_CODE=$(body_of "$RESP" | json_get code)
[[ -n "$INVITE_CODE" && "$INVITE_CODE" != "undefined" ]] || fail "invite response had no code: $(body_of "$RESP")"

step "register user2 with the invite"
RESP=$(http POST "$BASE/api/auth/register" "$JAR_USER2" \
  "{\"username\":\"user2\",\"password\":\"smoke-test-pass-2\",\"invite\":\"$INVITE_CODE\"}")
[[ "$(code_of "$RESP")" == "201" ]] || fail "register user2 expected 201, got $(code_of "$RESP"): $(body_of "$RESP")"
USER2_ID=$(body_of "$RESP" | json_get user.id)
[[ -n "$USER2_ID" && "$USER2_ID" != "undefined" ]] || fail "register user2 response had no user.id: $(body_of "$RESP")"

step "admin creates a 1-1 conversation with user2"
RESP=$(http POST "$BASE/api/conversations" "$JAR_ADMIN" "{\"user_ids\":[$USER2_ID]}")
[[ "$(code_of "$RESP")" == "201" ]] || fail "POST /api/conversations expected 201, got $(code_of "$RESP"): $(body_of "$RESP")"
CONV_ID=$(body_of "$RESP" | json_get conversation.id)
[[ -n "$CONV_ID" && "$CONV_ID" != "undefined" ]] || fail "create conversation response had no conversation.id: $(body_of "$RESP")"

step "admin sends a text message"
MSG_BODY="hello from smoke.sh"
RESP=$(http POST "$BASE/api/conversations/$CONV_ID/messages" "$JAR_ADMIN" "{\"body\":\"$MSG_BODY\"}")
[[ "$(code_of "$RESP")" == "201" ]] || fail "POST message expected 201, got $(code_of "$RESP"): $(body_of "$RESP")"

step "reading the message back"
RESP=$(http GET "$BASE/api/conversations/$CONV_ID/messages" "$JAR_ADMIN")
[[ "$(code_of "$RESP")" == "200" ]] || fail "GET messages expected 200, got $(code_of "$RESP"): $(body_of "$RESP")"
if ! grep -qF "$MSG_BODY" <<<"$(body_of "$RESP")"; then
  fail "sent message body not found in GET messages response: $(body_of "$RESP")"
fi
echo "message round-trip confirmed"

step "static serving check (GET /)"
if [[ -f "$ROOT_DIR/web/dist/index.html" ]]; then
  RESP=$(curl -s -w '\n%{http_code}' "$BASE/")
  [[ "$(code_of "$RESP")" == "200" ]] || fail "GET / expected 200, got $(code_of "$RESP")"
  if ! grep -qi "<html" <<<"$(body_of "$RESP")"; then
    fail "GET / did not return HTML: $(body_of "$RESP")"
  fi
  echo "GET / served the built web app"
else
  echo "WARNING: web/dist/index.html not found - skipping static-serving check"
  echo "(run 'cd web && npm run build' first to exercise it)"
fi

step "ALL CHECKS PASSED"
