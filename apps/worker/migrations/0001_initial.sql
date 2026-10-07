PRAGMA foreign_keys = ON;
CREATE TABLE episodes (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE clips (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id), data TEXT NOT NULL CHECK(json_valid(data)), visibility TEXT NOT NULL DEFAULT 'visible', revision INTEGER NOT NULL DEFAULT 0, active_attempt_id TEXT);
CREATE TABLE renders (id TEXT PRIMARY KEY, clip_id TEXT NOT NULL REFERENCES clips(id), data TEXT NOT NULL CHECK(json_valid(data)), revision INTEGER NOT NULL DEFAULT 0, decision TEXT NOT NULL DEFAULT 'clear', note TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', updated_at TEXT);
CREATE TABLE artifacts (render_id TEXT NOT NULL REFERENCES renders(id), kind TEXT NOT NULL CHECK(kind IN ('original','proxy')), file_id TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0), sha256 TEXT NOT NULL, mime TEXT NOT NULL CHECK(mime='video/mp4'), PRIMARY KEY(render_id,kind));
CREATE TABLE operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL CHECK(json_valid(response)));
CREATE TABLE review_events (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, render_id TEXT NOT NULL REFERENCES renders(id), expected_revision INTEGER NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('up','down','defer','clear')), note TEXT NOT NULL, reason TEXT NOT NULL, reviewer TEXT NOT NULL, occurred_at TEXT NOT NULL, fingerprint TEXT NOT NULL);
CREATE TRIGGER apply_review AFTER INSERT ON review_events BEGIN
 UPDATE renders SET revision=revision+1,decision=NEW.decision,note=NEW.note,reason=NEW.reason,updated_at=NEW.occurred_at WHERE id=NEW.render_id;
 INSERT INTO operations VALUES(NEW.operation_id,NEW.fingerprint,json_object('decision',NEW.decision,'revision',NEW.expected_revision+1,'note',NEW.note,'reason',NEW.reason,'updatedAt',NEW.occurred_at));
END;
CREATE TABLE visibility_events (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, clip_id TEXT NOT NULL REFERENCES clips(id), expected_revision INTEGER NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('visible','hidden')), reviewer TEXT NOT NULL, occurred_at TEXT NOT NULL, fingerprint TEXT NOT NULL);
CREATE TRIGGER apply_visibility AFTER INSERT ON visibility_events BEGIN
 UPDATE clips SET revision=revision+1,visibility=NEW.visibility WHERE id=NEW.clip_id;
 INSERT INTO operations VALUES(NEW.operation_id,NEW.fingerprint,json_object('visibility',NEW.visibility,'revision',NEW.expected_revision+1));
END;
CREATE TABLE producer_events (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, clip_id TEXT NOT NULL REFERENCES clips(id), sequence INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(attempt_id,sequence));
CREATE TABLE sync_state (id INTEGER PRIMARY KEY CHECK(id=1), last_success_at TEXT, last_error TEXT);
INSERT INTO sync_state(id) VALUES(1);
CREATE TRIGGER immutable_review_update BEFORE UPDATE ON review_events BEGIN SELECT RAISE(ABORT,'immutable review'); END;
CREATE TRIGGER immutable_review_delete BEFORE DELETE ON review_events BEGIN SELECT RAISE(ABORT,'immutable review'); END;
CREATE TRIGGER immutable_producer_update BEFORE UPDATE ON producer_events BEGIN SELECT RAISE(ABORT,'immutable producer event'); END;
CREATE TRIGGER immutable_producer_delete BEFORE DELETE ON producer_events BEGIN SELECT RAISE(ABORT,'immutable producer event'); END;
CREATE TRIGGER producer_attempt_owner BEFORE INSERT ON producer_events WHEN EXISTS(SELECT 1 FROM producer_events WHERE attempt_id=NEW.attempt_id AND clip_id<>NEW.clip_id) BEGIN SELECT RAISE(ABORT,'attempt ownership mismatch'); END;
CREATE TRIGGER producer_collision BEFORE INSERT ON producer_events WHEN EXISTS(SELECT 1 FROM producer_events WHERE (id=NEW.id OR (attempt_id=NEW.attempt_id AND sequence=NEW.sequence)) AND data<>NEW.data) BEGIN SELECT RAISE(ABORT,'immutable event collision'); END;
CREATE TRIGGER render_collision BEFORE INSERT ON renders WHEN EXISTS(SELECT 1 FROM renders WHERE id=NEW.id AND (data<>NEW.data OR clip_id<>NEW.clip_id)) BEGIN SELECT RAISE(ABORT,'immutable render collision'); END;
CREATE TRIGGER artifact_collision BEFORE INSERT ON artifacts WHEN EXISTS(SELECT 1 FROM artifacts WHERE render_id=NEW.render_id AND kind=NEW.kind AND (file_id<>NEW.file_id OR sha256<>NEW.sha256 OR size<>NEW.size)) BEGIN SELECT RAISE(ABORT,'immutable artifact collision'); END;
