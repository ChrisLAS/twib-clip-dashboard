-- Immutable candidate inputs and append-only human verification history.
CREATE TABLE airing_evidence (
 id TEXT PRIMARY KEY,
 owner TEXT NOT NULL,
 render_id TEXT NOT NULL REFERENCES renders(id),
 episode_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 source_snapshot TEXT NOT NULL CHECK(json_valid(source_snapshot)),
 data TEXT NOT NULL CHECK(json_valid(data)),
 revision INTEGER NOT NULL DEFAULT 0,
 decision TEXT NOT NULL DEFAULT 'unknown' CHECK(decision IN ('full','partial','unknown')),
 note TEXT NOT NULL DEFAULT '',
 verified_at TEXT,
 UNIQUE(owner,fingerprint)
);
CREATE INDEX airing_render ON airing_evidence(owner,render_id);
CREATE TABLE airing_events (
 id TEXT PRIMARY KEY,
 operation_id TEXT NOT NULL UNIQUE,
 evidence_id TEXT NOT NULL REFERENCES airing_evidence(id),
 owner TEXT NOT NULL,
 expected_revision INTEGER NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('full','partial','unknown')),
 action TEXT NOT NULL CHECK(action IN ('full','partial','unknown','undo')),
 note TEXT NOT NULL,
 verification TEXT NOT NULL CHECK(verification IN ('listened_compared_exact_render','none')),
 occurred_at TEXT NOT NULL,
 fingerprint TEXT NOT NULL
);
CREATE TRIGGER guard_airing_event BEFORE INSERT ON airing_events BEGIN
 SELECT RAISE(ABORT,'airing revision conflict') WHERE NOT EXISTS(SELECT 1 FROM airing_evidence WHERE id=NEW.evidence_id AND owner=NEW.owner AND revision=NEW.expected_revision);
 SELECT RAISE(ABORT,'stale airing render') WHERE NEW.decision IN ('full','partial') AND NOT EXISTS(SELECT 1 FROM airing_evidence e JOIN renders r ON r.id=e.render_id JOIN clips c ON c.id=r.clip_id WHERE e.id=NEW.evidence_id AND json_extract(c.data,'$.currentRenderId')=r.id AND json_extract(r.data,'$.artifactHash')=json_extract(e.data,'$.renderArtifactHash') AND json_extract(r.data,'$.recipeHash') IS json_extract(e.source_snapshot,'$.recipeHash') AND json_extract(r.data,'$.source') IS json_extract(e.source_snapshot,'$.source') AND json_extract(r.data,'$.cues') IS json_extract(e.source_snapshot,'$.cues') AND json_extract(r.data,'$.mappingVerified') IS json_extract(e.source_snapshot,'$.mappingVerified') AND json_extract(r.data,'$.durationMs') IS json_extract(e.source_snapshot,'$.durationMs'));
 SELECT RAISE(ABORT,'stale airing episode') WHERE NEW.decision IN ('full','partial') AND NOT EXISTS(SELECT 1 FROM airing_evidence e WHERE e.id=NEW.evidence_id AND (SELECT count(*) FROM publication_episodes p WHERE p.episode_id=e.episode_id)=1 AND EXISTS(SELECT 1 FROM publication_episodes p WHERE p.episode_id=e.episode_id AND json_extract(p.data,'$.editionFingerprint')=json_extract(e.data,'$.episodeEditionFingerprint') AND json_extract(p.data,'$.transcriptHash')=json_extract(e.data,'$.episodeTranscriptHash') AND EXISTS(SELECT 1 FROM publication_assets a WHERE a.asset_key=p.transcript_asset_key AND a.state='ready' AND a.hash=json_extract(p.data,'$.transcriptHash')) AND EXISTS(SELECT 1 FROM publication_assets WHERE asset_key='rss' AND state='ready')));
 SELECT RAISE(ABORT,'airing requires verification') WHERE NEW.decision IN ('full','partial') AND NEW.verification<>'listened_compared_exact_render';
END;
CREATE TRIGGER apply_airing_event AFTER INSERT ON airing_events BEGIN
 UPDATE airing_evidence SET revision=revision+1,decision=NEW.decision,note=NEW.note,verified_at=NEW.occurred_at WHERE id=NEW.evidence_id;
 INSERT INTO operations VALUES(NEW.operation_id,NEW.fingerprint,json_object('id',NEW.evidence_id,'revision',NEW.expected_revision+1,'decision',NEW.decision,'note',NEW.note,'verifiedAt',NEW.occurred_at));
 INSERT INTO operation_owners VALUES(NEW.operation_id,NEW.owner);
END;
CREATE TRIGGER immutable_airing_event_update BEFORE UPDATE ON airing_events BEGIN SELECT RAISE(ABORT,'immutable airing history'); END;
CREATE TRIGGER immutable_airing_event_delete BEFORE DELETE ON airing_events BEGIN SELECT RAISE(ABORT,'immutable airing history'); END;
CREATE TRIGGER immutable_airing_candidate BEFORE UPDATE ON airing_evidence WHEN NEW.data<>OLD.data OR NEW.owner<>OLD.owner OR NEW.render_id<>OLD.render_id OR NEW.episode_id<>OLD.episode_id OR NEW.fingerprint<>OLD.fingerprint OR NEW.source_snapshot<>OLD.source_snapshot BEGIN SELECT RAISE(ABORT,'immutable airing candidate'); END;
CREATE TRIGGER immutable_airing_delete BEFORE DELETE ON airing_evidence BEGIN SELECT RAISE(ABORT,'immutable airing candidate'); END;

CREATE TRIGGER guard_airing_candidate_insert BEFORE INSERT ON airing_evidence BEGIN
 SELECT RAISE(ABORT,'stale airing source') WHERE NOT EXISTS(SELECT 1 FROM renders r JOIN clips c ON c.id=r.clip_id WHERE r.id=NEW.render_id AND json_extract(c.data,'$.currentRenderId')=r.id AND json_extract(r.data,'$.artifactHash')=json_extract(NEW.data,'$.renderArtifactHash') AND json_extract(r.data,'$.recipeHash') IS json_extract(NEW.source_snapshot,'$.recipeHash') AND json_extract(r.data,'$.source') IS json_extract(NEW.source_snapshot,'$.source') AND json_extract(r.data,'$.cues') IS json_extract(NEW.source_snapshot,'$.cues') AND json_extract(r.data,'$.mappingVerified') IS json_extract(NEW.source_snapshot,'$.mappingVerified') AND json_extract(r.data,'$.durationMs') IS json_extract(NEW.source_snapshot,'$.durationMs'));
 SELECT RAISE(ABORT,'stale airing edition') WHERE (SELECT count(*) FROM publication_episodes p WHERE p.episode_id=NEW.episode_id)<>1 OR NOT EXISTS(SELECT 1 FROM publication_episodes p JOIN publication_assets a ON a.asset_key=p.transcript_asset_key WHERE p.episode_id=NEW.episode_id AND json_extract(p.data,'$.editionFingerprint')=json_extract(NEW.data,'$.episodeEditionFingerprint') AND json_extract(p.data,'$.transcriptHash')=json_extract(NEW.data,'$.episodeTranscriptHash') AND a.state='ready' AND a.hash=json_extract(NEW.data,'$.episodeTranscriptHash') AND EXISTS(SELECT 1 FROM publication_assets WHERE asset_key='rss' AND state='ready'));
END;
