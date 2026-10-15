-- Explicitly disabled automatic derivative transition. No authorization/config changes.
ALTER TABLE inventory_cut_requests ADD COLUMN source_plan_request_id TEXT REFERENCES inventory_cut_requests(request_id);
CREATE UNIQUE INDEX inventory_cut_single_plan_derivative ON inventory_cut_requests(source_plan_request_id) WHERE source_plan_request_id IS NOT NULL;
CREATE TRIGGER inventory_cut_source_plan_immutable BEFORE UPDATE OF source_plan_request_id ON inventory_cut_requests BEGIN SELECT RAISE(ABORT,'immutable source plan'); END;
