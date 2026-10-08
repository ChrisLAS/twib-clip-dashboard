-- Owner-managed planning metadata is separate from immutable producer manifests.
-- Real episode/folder metadata must be bootstrapped privately, never committed.
CREATE TABLE workspace_state (
 id INTEGER PRIMARY KEY CHECK(id=1),
 version INTEGER NOT NULL DEFAULT 0,
 intake_version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO workspace_state(id) VALUES(1);
CREATE TABLE episode_workspaces (
 id TEXT PRIMARY KEY,
 data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.id')=id),
 status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
 is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 upload_folder_url TEXT,
 CHECK(is_active=0 OR status='draft')
);
CREATE UNIQUE INDEX one_active_workspace ON episode_workspaces(is_active) WHERE is_active=1;
CREATE TRIGGER workspace_insert AFTER INSERT ON episode_workspaces BEGIN
 UPDATE workspace_state SET version=version+1 WHERE id=1;
END;
CREATE TRIGGER workspace_update AFTER UPDATE ON episode_workspaces BEGIN
 UPDATE workspace_state SET version=version+1 WHERE id=1;
END;
CREATE TRIGGER workspace_delete AFTER DELETE ON episode_workspaces BEGIN
 UPDATE workspace_state SET version=version+1 WHERE id=1;
END;

CREATE TABLE manual_intake (
 id TEXT PRIMARY KEY,
 owner TEXT NOT NULL,
 episode_id TEXT,
 canonical_url TEXT NOT NULL,
 in_ms INTEGER,
 out_ms INTEGER,
 status TEXT NOT NULL CHECK(status IN ('awaiting_processing','cancelled')),
 revision INTEGER NOT NULL CHECK(revision>0),
 data TEXT NOT NULL CHECK(json_valid(data)),
 CHECK((in_ms IS NULL AND out_ms IS NULL) OR (in_ms IS NOT NULL AND out_ms IS NOT NULL AND typeof(in_ms)='integer' AND typeof(out_ms)='integer' AND in_ms>=0 AND out_ms>in_ms AND out_ms<=604800000)),
 CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.canonicalUrl')=canonical_url AND json_extract(data,'$.revision')=revision AND json_extract(data,'$.status')=status),
 CHECK(json_extract(data,'$.episodeId') IS episode_id AND json_extract(data,'$.inMs') IS in_ms AND json_extract(data,'$.outMs') IS out_ms)
);
CREATE INDEX intake_episode ON manual_intake(owner,episode_id,status);
CREATE UNIQUE INDEX intake_exact_source_range ON manual_intake(owner,canonical_url,coalesce(in_ms,-1),coalesce(out_ms,-1)) WHERE status='awaiting_processing';
CREATE TABLE intake_events (
 id TEXT PRIMARY KEY,
 operation_id TEXT NOT NULL UNIQUE,
 intake_id TEXT NOT NULL,
 owner TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('create','update','cancel','restore')),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
 expected_catalog_version INTEGER NOT NULL,
 allow_different_range INTEGER NOT NULL CHECK(allow_different_range IN (0,1)),
 data TEXT NOT NULL CHECK(json_valid(data)),
 fingerprint TEXT NOT NULL
);
CREATE TABLE operation_owners (operation_id TEXT PRIMARY KEY REFERENCES operations(id),owner TEXT NOT NULL);
CREATE TRIGGER guard_intake_event BEFORE INSERT ON intake_events BEGIN
 SELECT CASE WHEN (SELECT version FROM sync_state WHERE id=1)<>NEW.expected_catalog_version THEN RAISE(ABORT,'intake catalog conflict') END;
 SELECT CASE WHEN json_extract(NEW.data,'$.id')<>NEW.intake_id OR json_extract(NEW.data,'$.revision')<>NEW.expected_revision+1 THEN RAISE(ABORT,'intake projection mismatch') END;
 SELECT CASE WHEN NEW.action='create' AND (NEW.expected_revision<>0 OR EXISTS(SELECT 1 FROM manual_intake WHERE id=NEW.intake_id)) THEN RAISE(ABORT,'intake revision conflict') END;
 SELECT CASE WHEN NEW.action<>'create' AND NOT EXISTS(SELECT 1 FROM manual_intake WHERE id=NEW.intake_id AND owner=NEW.owner AND revision=NEW.expected_revision) THEN RAISE(ABORT,'intake revision or owner conflict') END;
 SELECT CASE WHEN NEW.action IN ('update','cancel') AND (SELECT status FROM manual_intake WHERE id=NEW.intake_id)<>'awaiting_processing' THEN RAISE(ABORT,'intake state conflict') END;
 SELECT CASE WHEN NEW.action='restore' AND (SELECT status FROM manual_intake WHERE id=NEW.intake_id)<>'cancelled' THEN RAISE(ABORT,'intake state conflict') END;
 SELECT CASE WHEN json_extract(NEW.data,'$.status')<>CASE WHEN NEW.action='cancel' THEN 'cancelled' ELSE 'awaiting_processing' END THEN RAISE(ABORT,'intake state mismatch') END;
 SELECT CASE WHEN NEW.action<>'create' AND EXISTS(SELECT 1 FROM manual_intake WHERE id=NEW.intake_id AND (
  json_extract(data,'$.submittedUrl')<>json_extract(NEW.data,'$.submittedUrl') OR canonical_url<>json_extract(NEW.data,'$.canonicalUrl') OR
  json_extract(data,'$.provider')<>json_extract(NEW.data,'$.provider') OR json_extract(data,'$.kind')<>json_extract(NEW.data,'$.kind') OR
  json_extract(data,'$.createdAt')<>json_extract(NEW.data,'$.createdAt'))) THEN RAISE(ABORT,'immutable intake provenance') END;
 SELECT CASE WHEN json_extract(NEW.data,'$.episodeId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM episodes WHERE id=json_extract(NEW.data,'$.episodeId')) AND NOT EXISTS(SELECT 1 FROM episode_workspaces WHERE id=json_extract(NEW.data,'$.episodeId')) THEN RAISE(ABORT,'intake episode missing') END;
 SELECT CASE WHEN NEW.action<>'cancel' AND EXISTS(SELECT 1 FROM episode_workspaces WHERE id=json_extract(NEW.data,'$.episodeId') AND status='archived') THEN RAISE(ABORT,'intake workspace archived') END;
 SELECT CASE WHEN NEW.action<>'cancel' AND NEW.allow_different_range=0 AND EXISTS(SELECT 1 FROM manual_intake WHERE owner=NEW.owner AND id<>NEW.intake_id AND status='awaiting_processing' AND canonical_url=json_extract(NEW.data,'$.canonicalUrl')) THEN RAISE(ABORT,'intake duplicate source') END;
END;
CREATE TRIGGER apply_intake_event AFTER INSERT ON intake_events BEGIN
 INSERT INTO manual_intake(id,owner,episode_id,canonical_url,in_ms,out_ms,status,revision,data)
 VALUES(NEW.intake_id,NEW.owner,json_extract(NEW.data,'$.episodeId'),json_extract(NEW.data,'$.canonicalUrl'),json_extract(NEW.data,'$.inMs'),json_extract(NEW.data,'$.outMs'),json_extract(NEW.data,'$.status'),NEW.expected_revision+1,NEW.data)
 ON CONFLICT(id) DO UPDATE SET episode_id=excluded.episode_id,in_ms=excluded.in_ms,out_ms=excluded.out_ms,status=excluded.status,revision=excluded.revision,data=excluded.data;
 UPDATE workspace_state SET intake_version=intake_version+1 WHERE id=1;
 INSERT INTO operations(id,fingerprint,response) VALUES(NEW.operation_id,NEW.fingerprint,json_object('intake',json(NEW.data),'intakeVersion',(SELECT intake_version FROM workspace_state WHERE id=1)));
 INSERT INTO operation_owners(operation_id,owner) VALUES(NEW.operation_id,NEW.owner);
END;
CREATE TRIGGER immutable_intake_update BEFORE UPDATE ON intake_events BEGIN SELECT RAISE(ABORT,'immutable intake event'); END;
CREATE TRIGGER immutable_intake_delete BEFORE DELETE ON intake_events BEGIN SELECT RAISE(ABORT,'immutable intake event'); END;
