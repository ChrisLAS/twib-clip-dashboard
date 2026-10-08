-- Profile owner identifies whose guidance this is; actor identifies how it was applied.
ALTER TABLE editorial_events ADD COLUMN actor TEXT NOT NULL DEFAULT 'owner' CHECK(actor IN ('owner','assistant_bootstrap'));
