-- Distinct failure outcome: accepted proposal receipts remain acknowledgeable.
ALTER TABLE inventory_cut_requests ADD COLUMN transition_code TEXT;
