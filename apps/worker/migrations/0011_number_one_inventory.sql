-- Metadata-only inventory; intentionally unrelated to curated clips/renders/editorial.
CREATE TABLE inventory_snapshots (
  receipt_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0 AND sequence <= 9007199254740991),
  envelope_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  observed_ms INTEGER NOT NULL,
  accepted_at TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  UNIQUE(source_id, episode_id, scan_id),
  UNIQUE(source_id, episode_id, sequence)
);
CREATE TABLE inventory_items (
  source_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY(source_id, episode_id, item_id)
);
CREATE TABLE inventory_observations (
  receipt_id TEXT NOT NULL REFERENCES inventory_snapshots(receipt_id),
  source_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  observed_ms INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  item_json TEXT NOT NULL CHECK(json_valid(item_json)),
  PRIMARY KEY(receipt_id, item_id),
  FOREIGN KEY(source_id, episode_id, item_id) REFERENCES inventory_items(source_id, episode_id, item_id)
);
CREATE INDEX inventory_observations_latest ON inventory_observations(source_id, episode_id, item_id, sequence DESC);
CREATE INDEX inventory_snapshots_episode ON inventory_snapshots(source_id, episode_id, sequence DESC);

CREATE INDEX inventory_snapshots_digest ON inventory_snapshots(source_id, episode_id, digest);
-- Same semantic digest cannot silently represent different content across scans.
CREATE TRIGGER inventory_digest_consistency BEFORE INSERT ON inventory_snapshots
WHEN EXISTS (
  SELECT 1 FROM inventory_snapshots WHERE source_id=NEW.source_id AND episode_id=NEW.episode_id
    AND digest=NEW.digest AND payload_hash<>NEW.payload_hash
)
BEGIN
  SELECT RAISE(ABORT, 'inventory_digest_conflict');
END;
