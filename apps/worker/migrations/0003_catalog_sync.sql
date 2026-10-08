-- The singleton is both the catalog clock and a durable manual/cron lease.
ALTER TABLE sync_state ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN last_attempt_at TEXT;
ALTER TABLE sync_state ADD COLUMN lease_owner TEXT;
ALTER TABLE sync_state ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE sync_state ADD COLUMN sheet_hash TEXT;
ALTER TABLE clips ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0;
UPDATE sync_state SET version=1 WHERE EXISTS(SELECT 1 FROM episodes);
UPDATE clips SET catalog_revision=1;
CREATE TABLE imported_sheet_rows(hash TEXT PRIMARY KEY);
-- A failed CHECK aborts the entire D1 batch, including its receipt and projections.
CREATE TABLE sync_commit_guard(id INTEGER PRIMARY KEY CHECK(id=1), valid INTEGER NOT NULL CHECK(valid=1));
CREATE TRIGGER catalog_episode_insert AFTER INSERT ON episodes BEGIN
 UPDATE sync_state SET version=version+1 WHERE id=1;
END;
CREATE TRIGGER catalog_clip_insert AFTER INSERT ON clips BEGIN
 UPDATE sync_state SET version=version+1 WHERE id=1;
 UPDATE clips SET catalog_revision=(SELECT version FROM sync_state WHERE id=1) WHERE id=NEW.id;
END;
CREATE TRIGGER catalog_clip_update AFTER UPDATE OF data,active_attempt_id ON clips
WHEN OLD.data<>NEW.data OR OLD.active_attempt_id IS NOT NEW.active_attempt_id BEGIN
 UPDATE sync_state SET version=version+1 WHERE id=1;
 UPDATE clips SET catalog_revision=(SELECT version FROM sync_state WHERE id=1) WHERE id=NEW.id;
END;
CREATE TRIGGER catalog_render_insert AFTER INSERT ON renders BEGIN
 UPDATE sync_state SET version=version+1 WHERE id=1;
 UPDATE clips SET catalog_revision=(SELECT version FROM sync_state WHERE id=1) WHERE id=NEW.clip_id;
END;
CREATE TRIGGER catalog_artifact_insert AFTER INSERT ON artifacts BEGIN
 UPDATE sync_state SET version=version+1 WHERE id=1;
 UPDATE clips SET catalog_revision=(SELECT version FROM sync_state WHERE id=1) WHERE id=(SELECT clip_id FROM renders WHERE id=NEW.render_id);
END;
CREATE TRIGGER catalog_event_insert AFTER INSERT ON producer_events BEGIN
 UPDATE sync_state SET version=version+1 WHERE id=1;
 UPDATE clips SET catalog_revision=(SELECT version FROM sync_state WHERE id=1) WHERE id=NEW.clip_id;
END;
