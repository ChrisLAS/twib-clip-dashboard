-- Owner review overlay for existing Number One identities. No jobs or host actions.
-- 0012 is reserved for the separately unactivated capture-job proposal.
CREATE TABLE inventory_reviews (
 source_id TEXT NOT NULL, episode_id TEXT NOT NULL, review_key TEXT NOT NULL,
 item_id TEXT NOT NULL, producer_key TEXT,
 revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN ('unreviewed','approved','rejected','cut_down')),
 notes TEXT NOT NULL, reason TEXT NOT NULL, reviewed_version TEXT NOT NULL, version_basis TEXT NOT NULL,
 saved_at TEXT NOT NULL, owner TEXT NOT NULL,
 PRIMARY KEY(source_id,episode_id,review_key)
);
CREATE UNIQUE INDEX inventory_review_producer ON inventory_reviews(source_id,episode_id,producer_key) WHERE producer_key IS NOT NULL;
CREATE UNIQUE INDEX inventory_review_item ON inventory_reviews(source_id,episode_id,item_id);
CREATE TABLE inventory_review_operations (
 operation_id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_hash TEXT NOT NULL,
 response_json TEXT NOT NULL CHECK(json_valid(response_json))
);
