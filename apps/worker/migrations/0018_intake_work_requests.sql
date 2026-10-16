-- Explicit intake intent, separate from editorial review. No activation or grants.
CREATE TABLE intake_work_requests (
 job_id TEXT PRIMARY KEY REFERENCES capture_jobs(job_id), owner TEXT NOT NULL,
 intake_id TEXT NOT NULL, intake_revision INTEGER NOT NULL, episode_id TEXT NOT NULL,
 episode_number INTEGER NOT NULL CHECK(episode_number BETWEEN 1 AND 999999),
 workspace_revision INTEGER NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('normal','urgent')),
 spec_json TEXT NOT NULL CHECK(json_valid(spec_json)), created_at INTEGER NOT NULL,
 inventory_episode_id TEXT NOT NULL, cut_request_id TEXT, code TEXT,
 last_checked_at INTEGER NOT NULL DEFAULT 0,
 UNIQUE(owner,intake_id,intake_revision)
);
CREATE TRIGGER intake_work_immutable BEFORE UPDATE OF job_id,owner,intake_id,intake_revision,episode_id,episode_number,workspace_revision,priority,spec_json,created_at,inventory_episode_id ON intake_work_requests BEGIN SELECT RAISE(ABORT,'immutable intake work intent'); END;
CREATE TRIGGER intake_work_cut_immutable BEFORE UPDATE OF cut_request_id ON intake_work_requests WHEN OLD.cut_request_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable intake cut link'); END;
-- This view grants only processing intent, never an editorial approval or review credit.
-- Any subsequent human review, intake edit/cancel or episode release supersedes it.
CREATE VIEW intake_cut_authorizations AS
 SELECT c.request_id, 'nomad:number-one' AS source_id,w.inventory_episode_id AS episode_id,c.item_id,
 0 AS revision,'cut_down' AS status,c.parent_version AS reviewed_version
 FROM intake_work_requests w JOIN inventory_cut_requests c ON c.request_id=w.cut_request_id OR c.source_plan_request_id=w.cut_request_id
 JOIN manual_intake i ON i.id=w.intake_id AND i.owner=w.owner AND i.revision=w.intake_revision AND i.status='awaiting_processing' AND i.episode_id=w.episode_id
 JOIN episode_workspaces e ON e.id=w.episode_id AND e.revision=w.workspace_revision AND e.is_active=1 AND e.status='draft' AND json_extract(e.data,'$.number')=w.episode_number
 WHERE NOT EXISTS(SELECT 1 FROM inventory_reviews r WHERE r.source_id='nomad:number-one' AND r.episode_id=w.inventory_episode_id AND r.item_id=c.item_id);
