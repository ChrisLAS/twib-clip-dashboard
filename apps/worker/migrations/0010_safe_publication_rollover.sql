ALTER TABLE publication_sync ADD COLUMN rollover_issue TEXT;
-- Additive opt-in rollover. A fresh receipt is the only transition authority.
CREATE VIEW publication_workspace_numbers AS
 SELECT ids.id,coalesce(w.data,e.data) AS data,e.data AS imported_data,
 w.status,w.is_active,w.revision
 FROM (SELECT id FROM episodes UNION SELECT id FROM episode_workspaces) ids
 LEFT JOIN episodes e USING(id) LEFT JOIN episode_workspaces w USING(id);
CREATE TABLE publication_rollovers (
 id TEXT PRIMARY KEY,
 feed_id TEXT NOT NULL,
 guid TEXT NOT NULL,
 episode_id TEXT NOT NULL UNIQUE,
 episode_number INTEGER NOT NULL,
 next_id TEXT NOT NULL,
 workspace_version INTEGER NOT NULL,
 catalog_version INTEGER NOT NULL,
 active_revision INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(feed_id,guid)
);
-- A failed compare-and-swap is a safe skip, not a failure of RSS ingestion.
CREATE TRIGGER guard_publication_rollover BEFORE INSERT ON publication_rollovers BEGIN
 SELECT RAISE(IGNORE) WHERE (SELECT version FROM workspace_state WHERE id=1)<>NEW.workspace_version OR (SELECT version FROM sync_state WHERE id=1)<>NEW.catalog_version;
 SELECT RAISE(IGNORE) WHERE NOT EXISTS(SELECT 1 FROM publication_workspace_numbers WHERE id=NEW.episode_id AND status='draft' AND is_active=1 AND revision=NEW.active_revision AND json_extract(data,'$.number')=NEW.episode_number AND (json_extract(data,'$.publishedGuid') IS NULL OR json_extract(data,'$.publishedGuid')=NEW.guid) AND (json_extract(imported_data,'$.publishedGuid') IS NULL OR json_extract(imported_data,'$.publishedGuid')=NEW.guid));
 SELECT RAISE(IGNORE) WHERE (SELECT count(*) FROM publication_workspace_numbers WHERE json_extract(data,'$.number')=NEW.episode_number)<>1;
 -- Inspect both raw projections: workspace overrides must not hide another ID's number or GUID claim.
 SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM episodes WHERE json_extract(data,'$.number')=NEW.episode_number AND id<>NEW.episode_id) OR EXISTS(SELECT 1 FROM episode_workspaces WHERE json_extract(data,'$.number')=NEW.episode_number AND id<>NEW.episode_id);
 SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM episodes WHERE json_extract(data,'$.number')=NEW.episode_number+1 AND id<>NEW.next_id) OR EXISTS(SELECT 1 FROM episode_workspaces WHERE json_extract(data,'$.number')=NEW.episode_number+1 AND id<>NEW.next_id);
 SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM episodes WHERE json_extract(data,'$.publishedGuid')=NEW.guid AND id<>NEW.episode_id) OR EXISTS(SELECT 1 FROM episode_workspaces WHERE json_extract(data,'$.publishedGuid')=NEW.guid AND id<>NEW.episode_id);
 SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM publication_workspace_numbers WHERE id=NEW.episode_id AND imported_data IS NOT NULL AND json_extract(imported_data,'$.number') IS NOT NEW.episode_number);
 SELECT RAISE(IGNORE) WHERE NOT EXISTS(SELECT 1 FROM publication_episodes WHERE feed_id=NEW.feed_id AND guid=NEW.guid AND episode_id=NEW.episode_id AND json_extract(data,'$.episodeNumber')=NEW.episode_number);
 SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM publication_editions WHERE (feed_id=NEW.feed_id AND guid=NEW.guid AND json_extract(data,'$.episodeNumber') IS NOT NEW.episode_number) OR (json_extract(data,'$.episodeNumber')=NEW.episode_number AND (feed_id<>NEW.feed_id OR guid<>NEW.guid)));
 SELECT RAISE(IGNORE) WHERE NOT EXISTS(SELECT 1 FROM publication_assets WHERE asset_key='rss' AND state='ready');
 SELECT RAISE(IGNORE) WHERE (SELECT count(*) FROM publication_workspace_numbers WHERE json_extract(data,'$.number')=NEW.episode_number+1)>1;
 SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM publication_workspace_numbers WHERE (json_extract(data,'$.number')=NEW.episode_number+1 OR id=NEW.next_id) AND (id<>NEW.next_id OR json_extract(data,'$.number') IS NOT NEW.episode_number+1 OR status IS NOT 'draft' OR is_active<>0 OR json_extract(data,'$.publishedGuid') IS NOT NULL OR json_extract(imported_data,'$.publishedGuid') IS NOT NULL OR (imported_data IS NOT NULL AND json_extract(imported_data,'$.number') IS NOT NEW.episode_number+1)));
END;
CREATE TRIGGER apply_publication_rollover AFTER INSERT ON publication_rollovers BEGIN
 UPDATE episode_workspaces SET data=json_set(data,'$.publishedGuid',NEW.guid),status='published',is_active=0,revision=revision+1 WHERE id=NEW.episode_id;
 INSERT INTO episode_workspaces(id,data,status,is_active,upload_folder_url)
 SELECT NEW.next_id,json_object('id',NEW.next_id,'number',NEW.episode_number+1,'title','TWiB '||(NEW.episode_number+1),'subtitle','','clipCount',0,'publishedGuid',NULL),'draft',0,NULL
 WHERE NOT EXISTS(SELECT 1 FROM episode_workspaces WHERE id=NEW.next_id);
 UPDATE episode_workspaces SET is_active=1,revision=revision+1 WHERE id=NEW.next_id;
END;
CREATE TRIGGER immutable_publication_rollover_update BEFORE UPDATE ON publication_rollovers BEGIN SELECT RAISE(ABORT,'immutable publication rollover'); END;
CREATE TRIGGER immutable_publication_rollover_delete BEFORE DELETE ON publication_rollovers BEGIN SELECT RAISE(ABORT,'immutable publication rollover'); END;
