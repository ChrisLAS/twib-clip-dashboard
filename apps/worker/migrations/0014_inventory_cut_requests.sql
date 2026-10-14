-- Disabled request/derivative link. Does not activate transport or execute media work.
CREATE TABLE inventory_cut_requests (
 request_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, owner TEXT NOT NULL,
 parent_version TEXT NOT NULL, review_revision INTEGER NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 state TEXT NOT NULL CHECK(state IN ('requested','queued','running','needs_review','failed')),
 derivative_json TEXT CHECK(derivative_json IS NULL OR json_valid(derivative_json)),
 code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX inventory_cut_parent ON inventory_cut_requests(item_id,created_at);
CREATE TRIGGER inventory_cut_immutable BEFORE UPDATE OF request_id,item_id,owner,parent_version,review_revision,request_json ON inventory_cut_requests BEGIN SELECT RAISE(ABORT,'immutable cut request'); END;
CREATE TRIGGER inventory_cut_capacity BEFORE INSERT ON inventory_cut_requests WHEN (SELECT count(*) FROM inventory_cut_requests)>=1000 BEGIN SELECT RAISE(ABORT,'CUT_REQUEST_CAPACITY'); END;
