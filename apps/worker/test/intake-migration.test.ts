import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync(
  new URL("../migrations/0004_episode_workspaces_intake.sql", import.meta.url),
  "utf8",
);
const guardPattern = /CREATE TRIGGER guard_intake_event\b[\s\S]*?\nEND;/;
// Frozen pre-compatibility-fix guard: keep this independent of the new predicates.
const originalGuard = `CREATE TRIGGER guard_intake_event BEFORE INSERT ON intake_events BEGIN
 SELECT CASE WHEN (SELECT version FROM sync_state WHERE id=1)<>NEW.expected_catalog_version THEN RAISE(ABORT,'intake catalog conflict') END;
 SELECT CASE WHEN json_extract(NEW.data,'$.id')<>NEW.intake_id OR json_extract(NEW.data,'$.revision')<>NEW.expected_revision+1 THEN RAISE(ABORT,'intake projection mismatch') END;
 SELECT CASE WHEN NEW.action='create' AND (NEW.expected_revision<>0 OR EXISTS(SELECT 1 FROM manual_intake WHERE id=NEW.intake_id)) THEN RAISE(ABORT,'intake revision conflict') END;
 SELECT CASE WHEN NEW.action<>'create' AND NOT EXISTS(SELECT 1 FROM manual_intake WHERE id=NEW.intake_id AND owner=NEW.owner AND revision=NEW.expected_revision) THEN RAISE(ABORT,'intake revision or owner conflict') END;
 SELECT CASE WHEN NEW.action IN ('update','cancel') AND (SELECT status FROM manual_intake WHERE id=NEW.intake_id)<>'awaiting_processing' THEN RAISE(ABORT,'intake state conflict') END;
 SELECT CASE WHEN NEW.action='restore' AND (SELECT status FROM manual_intake WHERE id=NEW.intake_id)<>'cancelled' THEN RAISE(ABORT,'intake state conflict') END;
 SELECT CASE WHEN json_extract(NEW.data,'$.status')<>CASE WHEN NEW.action='cancel' THEN 'cancelled' ELSE 'awaiting_processing' END THEN RAISE(ABORT,'intake state mismatch') END;
 SELECT CASE WHEN NEW.action<>'create' AND EXISTS(SELECT 1 FROM manual_intake WHERE id=NEW.intake_id AND (
  json_extract(data,'$.submittedUrl')<>json_extract(NEW.data,'$.submittedUrl') OR canonical_url<>json_extract(NEW.data,'$.canonicalUrl') OR
  json_extract(data,'$.provider')<>json_extract(NEW.data,'$.provider') OR json_extract(data,'$.kind')<>json_extract(NEW.data,'$.kind') OR
  json_extract(data,'$.createdAt')<>json_extract(NEW.data,'$.createdAt'))) THEN RAISE(ABORT,'immutable intake provenance') END;
 SELECT CASE WHEN json_extract(NEW.data,'$.episodeId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM episodes WHERE id=json_extract(NEW.data,'$.episodeId')) AND NOT EXISTS(SELECT 1 FROM episode_workspaces WHERE id=json_extract(NEW.data,'$.episodeId')) THEN RAISE(ABORT,'intake episode missing') END;
 SELECT CASE WHEN NEW.action<>'cancel' AND EXISTS(SELECT 1 FROM episode_workspaces WHERE id=json_extract(NEW.data,'$.episodeId') AND status='archived') THEN RAISE(ABORT,'intake workspace archived') END;
 SELECT CASE WHEN NEW.action<>'cancel' AND NEW.allow_different_range=0 AND EXISTS(SELECT 1 FROM manual_intake WHERE owner=NEW.owner AND id<>NEW.intake_id AND status='awaiting_processing' AND canonical_url=json_extract(NEW.data,'$.canonicalUrl')) THEN RAISE(ABORT,'intake duplicate source') END;
END;`;

type Action = "create" | "update" | "cancel" | "restore";
type Data = Record<string, string | number | null>;
interface Event {
  action: Action;
  intakeId: string;
  owner: string;
  expectedRevision: number;
  catalogVersion: number;
  allowDifferentRange: number;
  data: Data;
}
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function database(legacy: boolean) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  for (const name of [
    "0001_initial",
    "0002_import_receipts",
    "0003_catalog_sync",
  ])
    db.exec(
      readFileSync(
        new URL(`../migrations/${name}.sql`, import.meta.url),
        "utf8",
      ),
    );
  db.exec(legacy ? migration.replace(guardPattern, originalGuard) : migration);
  for (const status of ["draft", "archived"])
    db.prepare(
      "INSERT INTO episode_workspaces(id,data,status) VALUES(?,?,?)",
    ).run(status, JSON.stringify({ id: status }), status);
  return db;
}
function event(
  action: Action = "create",
  expectedRevision = 0,
  overrides: Partial<Event> = {},
): Event {
  const intakeId = overrides.intakeId ?? "intake-one";
  return {
    action,
    expectedRevision,
    intakeId,
    owner: "owner-one",
    catalogVersion: 0,
    allowDifferentRange: 0,
    ...overrides,
    data: {
      id: intakeId,
      revision: expectedRevision + 1,
      status: action === "cancel" ? "cancelled" : "awaiting_processing",
      episodeId: "draft",
      inMs: null,
      outMs: null,
      submittedUrl: "https://youtu.be/abcdefghijk?source=fixture",
      canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      provider: "youtube",
      kind: "full_source",
      createdAt: "2026-10-08T00:00:00Z",
      ...overrides.data,
    },
  };
}
function insert(db: DatabaseSync, value: Event) {
  const id = `${value.intakeId}-${value.expectedRevision}-${value.action}`;
  db.prepare(
    `INSERT INTO intake_events(id,operation_id,intake_id,owner,action,
    expected_revision,expected_catalog_version,allow_different_range,data,fingerprint)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    `operation-${id}`,
    value.intakeId,
    value.owner,
    value.action,
    value.expectedRevision,
    value.catalogVersion,
    value.allowDifferentRange,
    JSON.stringify(value.data),
    `fingerprint-${id}`,
  );
}
function existing(db: DatabaseSync, cancelled = false) {
  insert(db, event());
  if (cancelled) insert(db, event("cancel", 1));
}
function snapshot(db: DatabaseSync) {
  return Object.fromEntries([
    ...["manual_intake", "intake_events", "operations", "operation_owners"].map(
      (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()],
    ),
    ["clock", db.prepare("SELECT * FROM workspace_state").get()],
  ]);
}
interface Scenario {
  name: string;
  error: string | null;
  arrange: (db: DatabaseSync) => Event;
}
const scenarios: Scenario[] = [
  {
    name: "catalog version",
    error: "intake catalog conflict",
    arrange: () => event("create", 0, { catalogVersion: 1 }),
  },
  {
    name: "projection identity",
    error: "intake projection mismatch",
    arrange: () => event("create", 0, { data: { id: "wrong" } }),
  },
  {
    name: "projection revision",
    error: "intake projection mismatch",
    arrange: () => event("create", 0, { data: { revision: 9 } }),
  },
  {
    name: "create revision",
    error: "intake revision conflict",
    arrange: () => event("create", 1),
  },
  {
    name: "existing create",
    error: "intake revision conflict",
    arrange: (db) => {
      existing(db);
      return event();
    },
  },
  {
    name: "missing update",
    error: "intake revision or owner conflict",
    arrange: () => event("update", 1),
  },
  {
    name: "wrong owner",
    error: "intake revision or owner conflict",
    arrange: (db) => {
      existing(db);
      return event("update", 1, { owner: "other-owner" });
    },
  },
  {
    name: "stale revision",
    error: "intake revision or owner conflict",
    arrange: (db) => {
      existing(db);
      return event("update", 2);
    },
  },
  ...(["update", "cancel"] as const).map((action) => ({
    name: `${action} of cancelled intake`,
    error: "intake state conflict",
    arrange: (db: DatabaseSync) => {
      existing(db, true);
      return event(action, 2);
    },
  })),
  {
    name: "restore of active intake",
    error: "intake state conflict",
    arrange: (db) => {
      existing(db);
      return event("restore", 1);
    },
  },
  {
    name: "status mismatch",
    error: "intake state mismatch",
    arrange: () => event("create", 0, { data: { status: "cancelled" } }),
  },
  ...["submittedUrl", "canonicalUrl", "provider", "kind", "createdAt"].map(
    (field) => ({
      name: `immutable ${field}`,
      error: "immutable intake provenance",
      arrange: (db: DatabaseSync) => {
        existing(db);
        return event("update", 1, { data: { [field]: "changed" } });
      },
    }),
  ),
  {
    name: "missing episode",
    error: "intake episode missing",
    arrange: () => event("create", 0, { data: { episodeId: "missing" } }),
  },
  {
    name: "archived episode",
    error: "intake workspace archived",
    arrange: () => event("create", 0, { data: { episodeId: "archived" } }),
  },
  {
    name: "duplicate source",
    error: "intake duplicate source",
    arrange: (db) => {
      existing(db);
      return event("create", 0, {
        intakeId: "intake-two",
        data: { inMs: 0, outMs: 1000 },
      });
    },
  },
  {
    name: "explicit different range",
    error: null,
    arrange: (db) => {
      existing(db);
      return event("create", 0, {
        intakeId: "intake-two",
        allowDifferentRange: 1,
        data: { inMs: 0, outMs: 1000 },
      });
    },
  },
  {
    name: "cancel archived assignment",
    error: null,
    arrange: (db) => {
      existing(db);
      return event("cancel", 1, { data: { episodeId: "archived" } });
    },
  },
  // Preserve SQLite's three-valued comparisons; API validation is tested separately.
  {
    name: "null episode",
    error: null,
    arrange: () => event("create", 0, { data: { episodeId: null } }),
  },
  {
    name: "null projection identity",
    error: null,
    arrange: () => event("create", 0, { data: { id: null } }),
  },
  {
    name: "null projection revision",
    error: null,
    arrange: () => event("create", 0, { data: { revision: null } }),
  },
  {
    name: "null provenance comparison",
    error: null,
    arrange: (db) => {
      existing(db);
      return event("update", 1, { data: { submittedUrl: null } });
    },
  },
  {
    name: "null status still fails column constraint",
    error: "NOT NULL constraint failed: manual_intake.status",
    arrange: () => event("create", 0, { data: { status: null } }),
  },
  {
    name: "null catalog subquery",
    error: null,
    arrange: (db) => {
      db.exec("DELETE FROM sync_state");
      return event();
    },
  },
];

describe("D1-compatible intake migration guard", () => {
  it("has eleven WHERE guards and no nested CASE or END inside the trigger", () => {
    const guard = migration.match(guardPattern)?.[0];
    expect(guard).toBeDefined();
    const body = guard!.replace(/^.*?\bBEGIN\b/s, "").replace(/\bEND;$/, "");
    expect(body).not.toMatch(/\b(?:CASE|END)\b/i);
    expect(body.match(/SELECT RAISE\(ABORT,'[^']+'\) WHERE/g)).toHaveLength(11);
    expect(body).toContain(
      "iif(NEW.action='cancel','cancelled','awaiting_processing')",
    );
  });

  it.each(scenarios)(
    "preserves old outcomes and atomic state: $name",
    ({ arrange, error }) => {
      const results = [true, false].map((legacy) => {
        const db = database(legacy);
        const candidate = arrange(db);
        const before = snapshot(db);
        let failure: string | null = null;
        try {
          insert(db, candidate);
        } catch (caught) {
          failure = caught instanceof Error ? caught.message : String(caught);
        }
        expect(failure).toBe(error);
        const after = snapshot(db);
        if (error) expect(after).toEqual(before);
        return { failure, after };
      });
      expect(results[1]).toEqual(results[0]);
    },
  );

  it("preserves the full lifecycle and all operation receipts", () => {
    const results = [true, false].map((legacy) => {
      const db = database(legacy);
      const states = [];
      for (const [revision, action] of (
        ["create", "update", "cancel", "restore"] as const
      ).entries()) {
        const value = event(action, revision);
        insert(db, value);
        const receipt = db
          .prepare("SELECT response FROM operations WHERE id=?")
          .get(`operation-${value.intakeId}-${revision}-${action}`);
        expect(JSON.parse(receipt!.response as string)).toEqual({
          intake: value.data,
          intakeVersion: revision + 1,
        });
        expect(
          db.prepare("SELECT status, revision FROM manual_intake").get(),
        ).toEqual({ status: value.data.status, revision: revision + 1 });
        expect(
          db.prepare("SELECT count(*) AS n FROM operation_owners").get()?.n,
        ).toBe(revision + 1);
        states.push(snapshot(db));
      }
      return states;
    });
    expect(results[1]).toEqual(results[0]);
  });

  it("rolls back projection, clock, event, and receipt on a late owner-receipt failure", () => {
    for (const legacy of [true, false]) {
      const db = database(legacy);
      existing(db);
      const before = snapshot(db);
      db.exec(
        "CREATE TRIGGER reject_owner_receipt BEFORE INSERT ON operation_owners BEGIN SELECT RAISE(ABORT,'receipt failure'); END;",
      );
      expect(() => insert(db, event("update", 1))).toThrow("receipt failure");
      expect(snapshot(db)).toEqual(before);
    }
  });
});
