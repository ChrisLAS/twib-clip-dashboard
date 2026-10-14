-- Disabled capture transport. No migration or grant is activated by code alone.
CREATE TABLE capture_jobs (
 job_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, owner TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_for_episode','blocked','needs_review','succeeded')),
 operation TEXT NOT NULL CHECK(operation IN ('capture','retry')), retry_id TEXT,
 lease_id TEXT, lease_expires_at INTEGER, attempt INTEGER NOT NULL DEFAULT 0,
 code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX capture_jobs_queue ON capture_jobs(state,created_at,job_id);
CREATE TABLE capture_job_claims (request_id TEXT PRIMARY KEY, response_json TEXT NOT NULL);
CREATE TABLE capture_job_deliveries (delivery_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, response_json TEXT NOT NULL);
CREATE TABLE capture_job_retries (retry_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, request_json TEXT NOT NULL);

CREATE TRIGGER capture_jobs_capacity BEFORE INSERT ON capture_jobs
WHEN NOT EXISTS(SELECT 1 FROM capture_jobs WHERE job_id=NEW.job_id)
 AND (SELECT count(*) FROM capture_jobs)>=1000 BEGIN SELECT RAISE(ABORT,'JOB_CAPACITY'); END;
CREATE TRIGGER capture_claims_capacity BEFORE INSERT ON capture_job_claims
WHEN NOT EXISTS(SELECT 1 FROM capture_job_claims WHERE request_id=NEW.request_id)
 AND (SELECT count(*) FROM capture_job_claims)>=10000 BEGIN SELECT RAISE(ABORT,'JOB_CAPACITY'); END;
CREATE TRIGGER capture_deliveries_capacity BEFORE INSERT ON capture_job_deliveries
WHEN NOT EXISTS(SELECT 1 FROM capture_job_deliveries WHERE delivery_id=NEW.delivery_id)
 AND (SELECT count(*) FROM capture_job_deliveries)>=50000 BEGIN SELECT RAISE(ABORT,'JOB_CAPACITY'); END;
