-- Separate public-source observations from owner workspaces and immutable renders.
CREATE TABLE publication_sync (
 id INTEGER PRIMARY KEY CHECK(id=1),
 last_attempt_at TEXT, last_success_at TEXT, last_scheduled_success_at TEXT, last_error TEXT,
 next_check_at INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT, lease_expires_at INTEGER,
 latest_guid TEXT, feed_id TEXT
);
INSERT INTO publication_sync(id) VALUES(1);
CREATE TABLE publication_assets (
 asset_key TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('rss','transcript','chapters')),
 url TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('missing','ready','blocked','error')),
 checked_at TEXT, fetched_at TEXT, hash TEXT, normalized_hash TEXT,
 etag TEXT, last_modified TEXT,
 next_retry_at INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
 body TEXT, parsed TEXT CHECK(parsed IS NULL OR json_valid(parsed)), error TEXT
);
CREATE TABLE publication_episodes (
 feed_id TEXT NOT NULL, guid TEXT NOT NULL,
 episode_id TEXT, transcript_asset_key TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(feed_id,guid)
);
CREATE INDEX publication_workspace ON publication_episodes(episode_id);
CREATE TABLE publication_editions (
 fingerprint TEXT PRIMARY KEY,
 feed_id TEXT NOT NULL, guid TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 observed_at TEXT NOT NULL
);
CREATE TABLE publication_commit_guard(id INTEGER PRIMARY KEY CHECK(id=1), valid INTEGER NOT NULL CHECK(valid=1));

CREATE TABLE publication_asset_versions (
 hash TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL,
 parsed TEXT NOT NULL CHECK(json_valid(parsed)), normalized_hash TEXT NOT NULL
);
