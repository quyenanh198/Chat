CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  media_mode TEXT NOT NULL DEFAULT 'once' CHECK(media_mode IN ('once','24h')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL,
  used_by INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  is_group INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  conversation_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','image','video')),
  body TEXT,
  media_path TEXT,
  media_mode TEXT CHECK(media_mode IN ('once','24h')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_views (
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY(message_id, user_id)
);

CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image','video')),
  media_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS story_views (
  story_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY(story_id, user_id)
);

CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
