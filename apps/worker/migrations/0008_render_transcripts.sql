-- Additive exact-render ASR observations. Original render/source mappings stay untouched.
CREATE TABLE render_transcript_assets (
 id TEXT PRIMARY KEY,
 owner TEXT NOT NULL,
 render_id TEXT NOT NULL REFERENCES renders(id),
 media_sha256 TEXT NOT NULL CHECK(length(media_sha256)=64 AND media_sha256 NOT GLOB '*[^a-f0-9]*'),
 duration_ms INTEGER NOT NULL CHECK(duration_ms>0),
 transcript_hash TEXT NOT NULL CHECK(length(transcript_hash)=64 AND transcript_hash NOT GLOB '*[^a-f0-9]*'),
 asset_hash TEXT NOT NULL CHECK(length(asset_hash)=64 AND asset_hash NOT GLOB '*[^a-f0-9]*'),
 created_at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 UNIQUE(owner,asset_hash)
);
CREATE INDEX render_transcript_latest ON render_transcript_assets(owner,render_id,media_sha256,created_at DESC,id DESC);
CREATE TRIGGER immutable_render_transcript_update BEFORE UPDATE ON render_transcript_assets BEGIN SELECT RAISE(ABORT,'immutable render transcript'); END;
CREATE TRIGGER immutable_render_transcript_delete BEFORE DELETE ON render_transcript_assets BEGIN SELECT RAISE(ABORT,'immutable render transcript'); END;
CREATE TRIGGER guard_render_transcript_insert BEFORE INSERT ON render_transcript_assets BEGIN
 SELECT RAISE(ABORT,'render transcript identity mismatch') WHERE NOT EXISTS(SELECT 1 FROM renders r WHERE r.id=NEW.render_id AND json_extract(r.data,'$.artifactHash')=NEW.media_sha256 AND json_extract(r.data,'$.durationMs')=NEW.duration_ms);
 SELECT RAISE(ABORT,'render transcript invalid metadata') WHERE json_extract(NEW.data,'$.id') IS NOT NEW.id OR json_extract(NEW.data,'$.renderId') IS NOT NEW.render_id OR json_extract(NEW.data,'$.mediaSha256') IS NOT NEW.media_sha256 OR json_extract(NEW.data,'$.durationMs') IS NOT NEW.duration_ms OR json_extract(NEW.data,'$.assetHash') IS NOT NEW.asset_hash OR json_extract(NEW.data,'$.transcriptHash') IS NOT NEW.transcript_hash OR json_extract(NEW.data,'$.createdAt') IS NOT NEW.created_at OR json_extract(NEW.data,'$.origin') IS NOT 'machine_asr' OR json_extract(NEW.data,'$.alignment') IS NOT 'exact_render' OR json_extract(NEW.data,'$.textAccuracy') IS NOT 'unverified' OR json_extract(NEW.data,'$.sourceMapping') IS NOT 'unknown' OR json_extract(NEW.data,'$.coordinateSpace') IS NOT 'clip_render';
 SELECT RAISE(ABORT,'render transcript invalid cues') WHERE json_type(NEW.data,'$.cues') IS NOT 'array' OR json_array_length(NEW.data,'$.cues') NOT BETWEEN 1 AND 10000 OR EXISTS(SELECT 1 FROM json_each(NEW.data,'$.cues') c WHERE json_type(c.value,'$.startMs') IS NOT 'integer' OR json_type(c.value,'$.endMs') IS NOT 'integer' OR json_extract(c.value,'$.startMs')<0 OR json_extract(c.value,'$.endMs')<=json_extract(c.value,'$.startMs') OR json_extract(c.value,'$.endMs')>NEW.duration_ms OR json_type(c.value,'$.text') IS NOT 'text' OR length(trim(json_extract(c.value,'$.text'))) NOT BETWEEN 1 AND 5000 OR json_type(c.value,'$.id') IS NOT 'text' OR length(json_extract(c.value,'$.id')) NOT BETWEEN 1 AND 120 OR (c.key>0 AND json_extract(c.value,'$.startMs')<json_extract(NEW.data,'$.cues['||(c.key-1)||'].endMs')));
 SELECT RAISE(ABORT,'render transcript duplicate cues') WHERE (SELECT count(*) FROM json_each(NEW.data,'$.cues'))<>(SELECT count(DISTINCT json_extract(value,'$.id')) FROM json_each(NEW.data,'$.cues'));
END;
-- These guards supplement 0007's render snapshot and current publication checks.
CREATE TRIGGER guard_airing_transcript_insert BEFORE INSERT ON airing_evidence BEGIN
 SELECT RAISE(ABORT,'stale airing transcript') WHERE json_extract(NEW.data,'$.sourceTranscriptAssetId') IS NOT (SELECT a.id FROM render_transcript_assets a JOIN renders r ON r.id=a.render_id WHERE a.owner=NEW.owner AND a.render_id=NEW.render_id AND a.media_sha256=json_extract(r.data,'$.artifactHash') AND a.duration_ms=json_extract(r.data,'$.durationMs') ORDER BY a.rowid DESC LIMIT 1);
 SELECT RAISE(ABORT,'airing transcript hash mismatch') WHERE json_extract(NEW.data,'$.sourceTranscriptAssetId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM render_transcript_assets a WHERE a.id=json_extract(NEW.data,'$.sourceTranscriptAssetId') AND a.owner=NEW.owner AND a.render_id=NEW.render_id AND a.media_sha256=json_extract(NEW.data,'$.renderArtifactHash') AND a.asset_hash=json_extract(NEW.data,'$.sourceTranscriptAssetHash'));
 SELECT RAISE(ABORT,'unverified airing mapping') WHERE json_extract(NEW.data,'$.status')='CANDIDATE' AND json_extract(NEW.data,'$.sourceTranscriptAssetId') IS NULL AND NOT EXISTS(SELECT 1 FROM renders r WHERE r.id=NEW.render_id AND json_extract(r.data,'$.mappingVerified')=1);
END;
CREATE TRIGGER guard_airing_transcript_event BEFORE INSERT ON airing_events WHEN NEW.decision IN ('full','partial') BEGIN
 SELECT RAISE(ABORT,'stale airing transcript') WHERE EXISTS(SELECT 1 FROM airing_evidence e WHERE e.id=NEW.evidence_id AND (json_extract(e.data,'$.sourceTranscriptAssetId') IS NOT (SELECT a.id FROM render_transcript_assets a JOIN renders r ON r.id=a.render_id WHERE a.owner=NEW.owner AND a.render_id=e.render_id AND a.media_sha256=json_extract(r.data,'$.artifactHash') AND a.duration_ms=json_extract(r.data,'$.durationMs') ORDER BY a.rowid DESC LIMIT 1) OR (json_extract(e.data,'$.sourceTranscriptAssetId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM render_transcript_assets a WHERE a.id=json_extract(e.data,'$.sourceTranscriptAssetId') AND a.owner=NEW.owner AND a.render_id=e.render_id AND a.media_sha256=json_extract(e.data,'$.renderArtifactHash') AND a.asset_hash=json_extract(e.data,'$.sourceTranscriptAssetHash')))));
END;
