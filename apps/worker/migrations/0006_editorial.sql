-- No private editorial seed belongs in a migration or demo fixture.
CREATE TABLE editorial_profiles(owner TEXT PRIMARY KEY,version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE editorial_events(id TEXT PRIMARY KEY,owner TEXT NOT NULL,operation_key TEXT NOT NULL,fingerprint TEXT NOT NULL,expected_revision INTEGER NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,UNIQUE(owner,operation_key));
CREATE TRIGGER guard_editorial_event BEFORE INSERT ON editorial_events BEGIN
 SELECT RAISE(ABORT,'editorial revision conflict') WHERE coalesce((SELECT version FROM editorial_profiles WHERE owner=NEW.owner),0)<>NEW.expected_revision;
 SELECT RAISE(ABORT,'editorial projection mismatch') WHERE json_extract(NEW.data,'$.version')<>NEW.expected_revision+1;
END;
CREATE TRIGGER apply_editorial_event AFTER INSERT ON editorial_events BEGIN
 INSERT INTO editorial_profiles(owner,version,data) VALUES(NEW.owner,NEW.expected_revision+1,NEW.data) ON CONFLICT(owner) DO UPDATE SET version=excluded.version,data=excluded.data;
END;
CREATE TABLE editorial_receipts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,operation_key TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,UNIQUE(owner,operation_key));
CREATE TRIGGER immutable_editorial_event_update BEFORE UPDATE ON editorial_events BEGIN SELECT RAISE(ABORT,'immutable editorial evidence'); END;
CREATE TRIGGER immutable_editorial_event_delete BEFORE DELETE ON editorial_events BEGIN SELECT RAISE(ABORT,'immutable editorial evidence'); END;
CREATE TRIGGER immutable_editorial_receipt_update BEFORE UPDATE ON editorial_receipts BEGIN SELECT RAISE(ABORT,'immutable editorial receipt'); END;
CREATE TRIGGER immutable_editorial_receipt_delete BEFORE DELETE ON editorial_receipts BEGIN SELECT RAISE(ABORT,'immutable editorial receipt'); END;
