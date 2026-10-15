-- Disabled planning receipts. No grants or activation changes.
ALTER TABLE inventory_cut_requests ADD COLUMN proposal_json TEXT CHECK(proposal_json IS NULL OR json_valid(proposal_json));
CREATE TRIGGER inventory_cut_proposal_immutable BEFORE UPDATE OF proposal_json ON inventory_cut_requests WHEN OLD.proposal_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable planning proposal'); END;
