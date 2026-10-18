import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  INVENTORY_MAX_BYTES,
  INVENTORY_MAX_ITEMS,
  inventoryEpisodeId,
  readInventoryBody,
  semanticHash,
  validateInventory,
  type InventoryGrant,
  type InventoryManifest,
  type InventoryEnvelope,
} from "../src/inventory/contract";
import {
  acceptInventory,
  inventoryEpisodeSelection,
  listInventory,
} from "../src/inventory/store";
import worker from "../src/index";
import type { Env } from "../src/env";
const example = JSON.parse(
  readFileSync(
    new URL("./fixtures/inventory.example.json", import.meta.url),
    "utf8",
  ),
) as InventoryManifest;
const now = Date.parse("2026-10-12T12:00:00Z");
const grant: InventoryGrant = {
  sourceId: "nomad:number-one",
  episodeId: example.episode.id,
  episodeNumber: 127,
  expiresAt: now + 60000,
  scope: "inventory:write",
  allowEditorialContext: true,
  originHosts: ["www.youtube.com", "example.com"],
};
const copy = () => structuredClone(example);
class Statement {
  values: (string | number | null)[] = [];
  constructor(
    private sqlite: DatabaseSync,
    private sql: string,
  ) {}
  bind(...values: (string | number | null)[]) {
    this.values = values;
    return this;
  }
  async first<T>() {
    return (this.sqlite.prepare(this.sql).get(...this.values) ??
      null) as T | null;
  }
  async all<T>() {
    return {
      results: this.sqlite.prepare(this.sql).all(...this.values) as T[],
    };
  }
  async run() {
    return this.sqlite.prepare(this.sql).run(...this.values);
  }
}
let sqlite: DatabaseSync;
let db: D1Database;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
});
const transport = (
  manifest = copy(),
  override: Partial<InventoryEnvelope> = {},
): InventoryEnvelope => ({
  schema: "number-one-inventory-envelope/v2",
  scan_id: "00000000-0000-4000-8000-" + manifest.idempotency_digest.slice(-12),
  sequence: parseInt(manifest.idempotency_digest[7], 16) + 1,
  manifest,
  ...override,
});
const accept = (
  manifest = copy(),
  database = db,
  authorization: InventoryGrant | null = grant,
  override: Partial<InventoryEnvelope> = {},
) => {
  const envelope = transport(manifest, override);
  return acceptInventory(
    database,
    envelope,
    envelope.scan_id,
    authorization,
    now,
  );
};
const count = (table: string) =>
  sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
function changed(digit = "a", time = "2026-10-12T10:03:00Z") {
  const manifest = copy();
  manifest.idempotency_digest = "sha256:" + digit.repeat(64);
  manifest.observed_at = time;
  manifest.scan_finished_at = time;
  return manifest;
}
describe("Number One inventory contract", () => {
  it("validates the exact synthetic handoff with the real Draft 2020-12 schema", async () => {
    expect(await inventoryEpisodeId(127)).toBe(example.episode.id);
    expect(
      await validateInventory(copy(), example.idempotency_digest, grant, now),
    ).toEqual(example);
  });
  it.each([
    null,
    { ...grant, expiresAt: now },
    { ...grant, scope: "owner" },
    { ...grant, episodeNumber: 128 },
    { ...grant, episodeId: "episode_" + "f".repeat(64) },
  ])("requires a current exact machine scope", async (authorization) => {
    await expect(
      accept(copy(), db, authorization as InventoryGrant | null),
    ).rejects.toMatchObject({ status: 403 });
    expect(count("inventory_snapshots")).toBe(0);
  });
  it("rejects self-asserted episode identity even when a grant repeats it", async () => {
    const m = copy();
    m.episode.id = "episode_" + "f".repeat(64);
    await expect(
      accept(m, db, { ...grant, episodeId: m.episode.id }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it.each([
    "unknownField",
    "ready",
    "deletions",
    "wrongKind",
    "date",
    "duplicate",
    "future",
    "reversed",
  ])("rejects schema/semantic violation: %s", async (variant) => {
    const m = copy();
    if (variant === "unknownField")
      Object.assign(m, { credential: "SYNTHETIC" });
    if (variant === "ready") Object.assign(m.items[0], { ready: true });
    if (variant === "deletions")
      Object.assign(m.snapshot, { allow_deletions: true });
    if (variant === "wrongKind") m.items[0].kind = "media";
    if (variant === "date") m.observed_at = "2026-02-30T10:00:00Z";
    if (variant === "duplicate") m.items.push(structuredClone(m.items[0]));
    if (variant === "future") m.scan_finished_at = "2026-10-13T10:00:00Z";
    if (variant === "reversed") m.observed_at = "2026-10-12T11:00:00Z";
    await expect(accept(m)).rejects.toMatchObject({ status: 422 });
  });
  it.each([
    "/private/host/file",
    "../clip.mp4",
    "x/../clip",
    "https://example.com/file",
    "C:media.mp4",
    "a\\b",
    "a\u0000b",
    "%2e%2e/clip",
    "a?token=x",
    "a/%252e%252e/b",
  ])("rejects unsafe relative reference %s", async (ref) => {
    const m = copy();
    m.coverage[0].artifact = ref;
    await expect(accept(m)).rejects.toMatchObject({ status: 422 });
  });
  it.each([
    "http://127.0.0.1./path",
    "http://localhost./path",
    "http://0177.0.0.1/path",
    "http://2130706433/path",
    "http://[::1]/path",
    "https://user:password@example.com/path",
    "https://example.com/path?token=SYNTHETIC",
    "https://example.com/path#fragment",
    "https://example.com:444/path",
    "https://example.com/token%3DSYNTHETIC",
    "https://not-approved.example/path",
  ])("rejects unsafe or unapproved origin %s", async (url) => {
    const m = copy();
    m.items[0].origins[0].url = url;
    await expect(accept(m)).rejects.toMatchObject({ status: 422 });
  });
  it.each([
    "token=SYNTHETIC",
    "Bearer SYNTHETIC",
    "a /private/host/file",
    "C:\\Users\\private",
    "https://example.com/path?private=SYNTHETIC",
  ])(
    "rejects rather than stores recognizable sensitive prose %s",
    async (text) => {
      const m = copy();
      m.items[0].observations[0].context.title = text;
      await expect(accept(m)).rejects.toMatchObject({ status: 422 });
      expect(count("inventory_snapshots")).toBe(0);
    },
  );
  it("requires explicit editorial privacy policy and exact digest header", async () => {
    await expect(
      accept(copy(), db, { ...grant, allowEditorialContext: false }),
    ).rejects.toMatchObject({ code: "INVENTORY_PRIVACY_REVIEW_REQUIRED" });
    await expect(
      validateInventory(copy(), null, grant, now),
    ).rejects.toMatchObject({ code: "INVENTORY_KEY_MISMATCH" });
  });
  it("enforces item and per-item bounds before persistence", async () => {
    const m = copy();
    m.items = Array(INVENTORY_MAX_ITEMS + 1).fill(m.items[0]);
    await expect(accept(m)).rejects.toMatchObject({ code: "INVENTORY_LIMIT" });
    const huge = copy();
    huge.items[0].observations = Array(100).fill({
      ...huge.items[0].observations[0],
      context: { title: "x".repeat(4000) },
    });
    await expect(accept(huge)).rejects.toMatchObject({
      code: "INVENTORY_LIMIT",
    });
  });
});
describe("durable isolated inventory storage", () => {
  it("accepts the distributed synthetic v2 envelope example", async () => {
    const envelope = JSON.parse(
      readFileSync(
        new URL("./fixtures/inventory.envelope.example.json", import.meta.url),
        "utf8",
      ),
    ) as InventoryEnvelope;
    const receipt = await acceptInventory(
      db,
      envelope,
      envelope.scan_id,
      grant,
      now,
    );
    expect(receipt).toMatchObject({
      schema: "number-one-inventory-receipt/v2",
      scan_id: envelope.scan_id,
      sequence: 1,
      digest: example.idempotency_digest,
    });
  });
  it("returns original receipt for an immutable retry despite property order", async () => {
    const first = await accept();
    const replay = copy();

    replay.items[0].observations[1].context = Object.fromEntries(
      Object.entries(replay.items[0].observations[1].context).reverse(),
    );
    expect(await semanticHash(replay)).toBe(await semanticHash(example));
    expect(await accept(replay)).toEqual(first);
    expect(count("inventory_snapshots")).toBe(1);
    expect(count("inventory_observations")).toBe(1);
  });
  it("orders a fresh A-to-B-to-A scan independently of repeated content digest", async () => {
    const original = await accept();
    const b = changed();
    b.items[0].processing_status = "failed";
    await accept(b);
    const again = copy();
    again.observed_at = "2026-10-12T11:00:00Z";
    again.scan_finished_at = "2026-10-12T11:00:01Z";
    const latest = await accept(again, db, grant, {
      scan_id: "00000000-0000-4000-8000-cccccccccccc",
      sequence: 20,
    });
    expect(latest.digest).toBe(original.digest);
    expect(latest.receipt_id).not.toBe(original.receipt_id);
    const view = await listInventory(db, example.episode.id);
    expect(view.items[0].variants[0].item.processing_status).toBe(
      "capture_required",
    );
    expect(view.items[0].variants[0].sequence).toBe(20);
    expect(count("inventory_snapshots")).toBe(3);
  });
  it("rejects digest reuse for changed content without mutation", async () => {
    await accept();
    const m = copy();
    m.items[0].processing_status = "failed";
    await expect(
      accept(m, db, grant, {
        scan_id: "00000000-0000-4000-8000-cccccccccccc",
        sequence: 20,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_DIGEST_CONFLICT",
    });
    expect(count("inventory_snapshots")).toBe(1);
  });
  it("rejects mutation of scan timestamps or sequence on a retry", async () => {
    await accept();
    const m = copy();
    m.scan_finished_at = "2026-10-12T10:02:02Z";
    expect(await semanticHash(m)).toBe(await semanticHash(example));
    await expect(accept(m)).rejects.toMatchObject({
      code: "INVENTORY_SCAN_CONFLICT",
    });
    await expect(
      accept(copy(), db, grant, { sequence: 2 }),
    ).rejects.toMatchObject({ code: "INVENTORY_SCAN_CONFLICT" });
    expect(count("inventory_snapshots")).toBe(1);
  });
  it("rejects duplicate sequences with a different scan ID", async () => {
    await accept();
    await expect(
      accept(copy(), db, grant, {
        scan_id: "00000000-0000-4000-8000-cccccccccccc",
      }),
    ).rejects.toMatchObject({ code: "INVENTORY_SEQUENCE_CONFLICT" });
    expect(count("inventory_snapshots")).toBe(1);
  });
  it("uses sequence when the source clock moves backwards and permits gaps", async () => {
    await accept();
    const m = changed("b", "2026-10-12T09:00:00Z");
    m.items[0].processing_status = "failed";
    await accept(m, db, grant, { sequence: 100 });
    const view = await listInventory(db, example.episode.id);
    expect(view.items[0].variants[0].item.processing_status).toBe("failed");
    expect(view.items[0].variants[0].sequence).toBe(100);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid sequence %s",
    async (sequence) => {
      await expect(
        accept(copy(), db, grant, { sequence }),
      ).rejects.toMatchObject({ status: 422 });
    },
  );
  it("requires exact envelope fields, UUIDv4 and scan-ID header", async () => {
    const envelope = transport();
    await expect(
      acceptInventory(
        db,
        { ...envelope, extra: true },
        envelope.scan_id,
        grant,
        now,
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_ENVELOPE_INVALID" });
    await expect(
      accept(copy(), db, grant, { scan_id: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "INVENTORY_ENVELOPE_INVALID" });
    await expect(
      acceptInventory(db, envelope, example.idempotency_digest, grant, now),
    ).rejects.toMatchObject({ code: "INVENTORY_KEY_MISMATCH" });
    await expect(
      acceptInventory(db, copy(), example.idempotency_digest, grant, now),
    ).rejects.toMatchObject({ code: "INVENTORY_ENVELOPE_INVALID" });
  });
  it("retains absent items on both complete and partial snapshots", async () => {
    await accept();
    const partial = changed();
    partial.items = [];
    partial.snapshot.complete = false;
    await accept(partial);
    const complete = changed("b");
    complete.items = [];
    await accept(complete);
    const view = await listInventory(db, example.episode.id);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].variants[0].item).toEqual(example.items[0]);
    expect(count("inventory_snapshots")).toBe(3);
  });
  it("retains history without letting late older snapshots roll back an item", async () => {
    const newer = changed();
    newer.items[0].processing_status = "failed";
    await accept(newer);
    await accept();
    const view = await listInventory(db, example.episode.id);
    expect(view.items[0].variants[0].item.processing_status).toBe("failed");
    expect(count("inventory_observations")).toBe(2);
  });
  it("orders equal-time scans by sequence and marks no item playable", async () => {
    await accept();
    const m = changed("b", example.observed_at);
    m.items[0].processing_status = "failed";
    await accept(m);
    const view = await listInventory(db, example.episode.id);
    expect(view.items[0].conflictingLatestObservations).toBe(false);
    expect(view.items[0].variants).toHaveLength(1);
    expect(view.items[0].variants[0].item.processing_status).toBe("failed");
    expect(view.items[0].readiness).toBe("not_evaluated");
    expect(view.items[0].variants.every((v) => v.item.ready === false)).toBe(
      true,
    );
    expect(count("clips")).toBe(0);
    expect(count("renders")).toBe(0);
  });
  it("rolls back receipt and identities if observation storage fails", async () => {
    sqlite.exec(
      "CREATE TRIGGER inventory_fail BEFORE INSERT ON inventory_observations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    await expect(accept()).rejects.toThrow();
    expect(count("inventory_snapshots")).toBe(0);
    expect(count("inventory_items")).toBe(0);
    expect(count("inventory_observations")).toBe(0);
  });
  it("recovers a matching durable receipt after an uncertain batch response", async () => {
    const uncertain = {
      ...db,
      batch: async (statements: D1PreparedStatement[]) => {
        await db.batch(statements);
        throw new Error("lost response");
      },
    } as unknown as D1Database;
    const receipt = await accept(copy(), uncertain);
    expect(receipt.digest).toBe(example.idempotency_digest);
    expect(count("inventory_snapshots")).toBe(1);
  });
  it("handles competing submissions atomically", async () => {
    const [a, b] = await Promise.all([accept(), accept()]);
    expect(a).toEqual(b);
    expect(count("inventory_snapshots")).toBe(1);
  });
  it("does not mix episode reads", async () => {
    await accept();
    expect(
      (await listInventory(db, await inventoryEpisodeId(128))).items,
    ).toEqual([]);
  });
  it("paginates inventory without missing or duplicating identities", async () => {
    const m = copy();
    m.items = Array.from({ length: 23 }, (_, i) => ({
      ...structuredClone(m.items[0]),
      id: "item_" + i.toString(16).padStart(64, "0"),
    }));
    await accept(m);
    const first = await listInventory(db, m.episode.id);
    expect(first.items).toHaveLength(20);
    const second = await listInventory(db, m.episode.id, first.nextCursor);
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(23);
  });
});
describe("owner inventory read model", () => {
  const syntheticItems = (length: number) =>
    Array.from({ length }, (_, i) => ({
      ...structuredClone(example.items[0]),
      id: "item_" + i.toString(16).padStart(64, "0"),
      processing_status: i % 2 === 0 ? "failed" : "capture_required",
      observations: [
        {
          artifact: `transcripts/synthetic-${i}.json`,
          status: "candidate",
          context: {},
          timestamps: {},
        },
      ],
    }));
  it("counts every retained latest identity independently of page, filter and snapshot size", async () => {
    const original = copy();
    original.items = syntheticItems(43);
    await accept(original);
    const newer = changed();
    newer.items = [structuredClone(original.items[0])];
    newer.items[0].processing_status = "quarantined";
    newer.items[0].kind = "media";
    newer.items[0].media = {
      ref: "synthetic-0.mp4",
      present: true,
      size_bytes: 1,
      modified_at: null,
      duration_seconds: null,
    };
    newer.snapshot.complete = false;
    await accept(newer);
    const empty = changed("b");
    empty.items = [];
    await accept(empty);
    const prepare = vi.fn((sql: string) => db.prepare(sql));
    const view = await listInventory(
      { prepare } as unknown as D1Database,
      original.episode.id,
    );
    // One extra bounded query freezes the sort/pagination watermark.
    expect(prepare).toHaveBeenCalledTimes(5);
    expect(view.items).toHaveLength(20);
    expect(view.summary).toEqual({
      totalItems: 43,
      matchedItems: 43,
      groupCounts: { all: 43, media: 0, research: 0, attention: 43 },
      statusCounts: {
        candidate: 0,
        capture_required: 21,
        failed: 21,
        captured_observed: 0,
        unverified: 0,
        incomplete: 0,
        missing: 0,
        quarantined: 1,
      },
    });
    expect(view.latestReceipt?.stored_item_count).toBe(0);
    const filtered = await listInventory(db, original.episode.id, null, {
      status: "failed",
    });
    expect(filtered.summary).toEqual({ ...view.summary, matchedItems: 21 });
    expect(filtered.items).toHaveLength(20);
    const rest = await listInventory(
      db,
      original.episode.id,
      filtered.nextCursor,
      { status: "failed" },
    );
    expect(rest.items).toHaveLength(1);
    expect(rest.summary).toEqual(filtered.summary);
    expect(rest.nextCursor).toBeNull();
    expect(
      new Set([...filtered.items, ...rest.items].map((item) => item.id)).size,
    ).toBe(21);
  });
  it("searches current relative references, item IDs and evidence, with literal wildcard characters", async () => {
    const manifest = copy();
    manifest.items = syntheticItems(3);
    manifest.items[0].kind = "media";
    manifest.items[0].processing_status = "unverified";
    manifest.items[0].media = {
      ref: "synthetic%_clip.mp4",
      present: true,
      size_bytes: 1,
      modified_at: null,
      duration_seconds: null,
    };
    manifest.items[1].capture_evidence = [
      {
        artifact: "capture-receipts/synthetic-evidence.json",
        matches_observed_size: false,
        content_hash_verified: false,
        streams_reprobed: false,
      },
    ];
    await accept(manifest);
    const search = (query: string) =>
      listInventory(db, manifest.episode.id, null, { query });
    expect((await search("%_")).items.map((item) => item.id)).toEqual([
      manifest.items[0].id,
    ]);
    expect(
      (await search(" SYNTHETIC-1.JSON ")).items.map((item) => item.id),
    ).toEqual([manifest.items[1].id]);
    expect(
      (await search("synthetic-evidence")).items.map((item) => item.id),
    ).toEqual([manifest.items[1].id]);
    expect(
      (await search(manifest.items[2].id)).items.map((item) => item.id),
    ).toEqual([manifest.items[2].id]);
    expect((await search("' OR 1=1 --")).summary.matchedItems).toBe(0);
    expect((await search("youtube")).items).toHaveLength(0);
    const replacement = changed();
    replacement.items = [structuredClone(manifest.items[1])];
    replacement.items[0].observations[0].artifact =
      "transcripts/replacement.json";
    replacement.items[0].capture_evidence = [];
    await accept(replacement);
    expect((await search("synthetic-1.json")).items).toHaveLength(0);
    expect((await search("synthetic-evidence")).items).toHaveLength(0);
    expect((await search("replacement")).items).toHaveLength(1);
  });
  it("applies search and status before pagination and combines them", async () => {
    const manifest = copy();
    manifest.items = syntheticItems(50);
    for (const item of manifest.items)
      item.observations[0].artifact =
        item.processing_status === "failed"
          ? "transcripts/synthetic-match.json"
          : "transcripts/unrelated.json";
    await accept(manifest);
    const options = { query: "synthetic-match", status: "failed" };
    const first = await listInventory(db, manifest.episode.id, null, options);
    const next = await listInventory(
      db,
      manifest.episode.id,
      first.nextCursor,
      options,
    );
    expect(first.items).toHaveLength(20);
    expect(next.items).toHaveLength(5);
    expect(first.summary.matchedItems).toBe(25);
    expect(next.summary.matchedItems).toBe(25);
    expect(next.nextCursor).toBeNull();
    expect(
      (
        await listInventory(db, manifest.episode.id, null, {
          ...options,
          status: "capture_required",
        })
      ).items,
    ).toHaveLength(0);
  });
  function asObservedMedia(
    item: InventoryManifest["items"][number],
    ref: string,
  ) {
    item.kind = "media";
    item.processing_status = "captured_observed";
    item.media = {
      ref,
      present: true,
      size_bytes: 1,
      modified_at: null,
      duration_seconds: null,
    };
    item.capture_evidence = [
      {
        artifact: "capture-receipts/synthetic.json",
        matches_observed_size: true,
        content_hash_verified: false,
        streams_reprobed: false,
        producer_sha256: "a".repeat(64),
      },
    ];
  }
  it("paginates separate media, research and attention groups while retaining global counts", async () => {
    const manifest = copy();
    manifest.items = syntheticItems(69);
    for (const [index, item] of manifest.items.entries()) {
      if (index % 3 === 0) asObservedMedia(item, `synthetic-${index}.mp4`);
      else item.processing_status = index % 3 === 1 ? "candidate" : "failed";
      item.observations[0].artifact =
        index % 2 === 0
          ? "transcripts/synthetic-group-match.json"
          : "transcripts/synthetic-unrelated.json";
    }
    await accept(manifest);
    const all = await listInventory(db, manifest.episode.id);
    expect(all.filters.group).toBe("all");
    expect(all.summary.totalItems).toBe(69);
    expect(all.summary.matchedItems).toBe(69);
    expect(all.summary.groupCounts).toEqual({
      all: 69,
      media: 23,
      research: 23,
      attention: 23,
    });
    const groupIds: string[] = [];
    for (const group of ["media", "research", "attention"] as const) {
      const first = await listInventory(db, manifest.episode.id, null, {
        group,
      });
      expect(first.filters.group).toBe(group);
      expect(first.items).toHaveLength(20);
      expect(first.summary).toEqual({ ...all.summary, matchedItems: 23 });
      const next = await listInventory(
        db,
        manifest.episode.id,
        first.nextCursor,
        { group },
      );
      expect(next.items).toHaveLength(3);
      expect(next.nextCursor).toBeNull();
      const ids = [...first.items, ...next.items].map((item) => item.id);
      expect(new Set(ids).size).toBe(23);
      groupIds.push(...ids);
    }
    expect(new Set(groupIds).size).toBe(69);
    const search = await listInventory(db, manifest.episode.id, null, {
      group: "media",
      status: "captured_observed",
      query: "synthetic-group-match",
    });
    expect(search.summary).toEqual({ ...all.summary, matchedItems: 12 });
    expect(search.items).toHaveLength(12);
    const incompatible = await listInventory(db, manifest.episode.id, null, {
      group: "media",
      status: "candidate",
    });
    expect(incompatible.items).toEqual([]);
    expect(incompatible.summary).toEqual({ ...all.summary, matchedItems: 0 });
    const replacement = changed();
    replacement.items = [structuredClone(manifest.items[0])];
    replacement.items[0].processing_status = "incomplete";
    replacement.snapshot.complete = false;
    await accept(replacement);
    const updated = await listInventory(db, manifest.episode.id, null, {
      group: "media",
    });
    expect(updated.summary.totalItems).toBe(69);
    expect(updated.summary.matchedItems).toBe(22);
    expect(updated.summary.groupCounts).toEqual({
      all: 69,
      media: 22,
      research: 23,
      attention: 24,
    });
    expect(updated.summary.statusCounts.captured_observed).toBe(22);
    expect(updated.summary.statusCounts.incomplete).toBe(1);
  });
  it("requires observed capture and a recognized audio/video suffix for the media group", async () => {
    const suffixes = [
      "mp4",
      "m4v",
      "mov",
      "webm",
      "mkv",
      "avi",
      "mp3",
      "m4a",
      "aac",
      "wav",
      "flac",
      "ogg",
      "opus",
      "aiff",
    ];
    const refs = [
      ...suffixes.map((suffix) => `synthetic.${suffix.toUpperCase()}`),
      "synthetic.mp4.part",
      "synthetic.part",
      "synthetic.json",
      "synthetic.mp4.tmp",
    ];
    const manifest = copy();
    manifest.items = syntheticItems(refs.length + 6);
    for (const [index, ref] of refs.entries())
      asObservedMedia(manifest.items[index], ref);
    const attentionStatuses = [
      "unverified",
      "incomplete",
      "missing",
      "quarantined",
    ];
    for (const [index, status] of attentionStatuses.entries()) {
      const item = manifest.items[refs.length + index];
      asObservedMedia(item, "synthetic.mp4");
      item.processing_status = status;
      item.media!.present = status !== "missing";
    }
    manifest.items[refs.length + 4].processing_status = "candidate";
    manifest.items[refs.length + 5].processing_status = "capture_required";
    await accept(manifest);
    const media = await listInventory(db, manifest.episode.id, null, {
      group: "media",
    });
    expect(media.items.map((item) => item.variants[0].item.media?.ref)).toEqual(
      refs.slice(0, suffixes.length),
    );
    expect(media.summary.groupCounts).toEqual({
      all: 24,
      media: 14,
      research: 1,
      attention: 9,
    });
    expect(media.summary.statusCounts.captured_observed).toBe(18);
    expect(
      media.items.every(
        (item) =>
          item.readiness === "not_evaluated" &&
          item.variants[0].item.ready === false,
      ),
    ).toBe(true);
    const capturedAttention = await listInventory(
      db,
      manifest.episode.id,
      null,
      { group: "attention", status: "captured_observed" },
    );
    expect(capturedAttention.items).toHaveLength(4);
    expect(capturedAttention.summary.matchedItems).toBe(4);
    expect(capturedAttention.summary.statusCounts.captured_observed).toBe(18);
  });
  it("keeps inconsistent recorded kind, status, presence and reference metadata in attention", async () => {
    const manifest = copy();
    asObservedMedia(manifest.items[0], "synthetic.mp4");
    await accept(manifest);
    const item = manifest.items[0];
    const inconsistent = [
      { ...item, media: { ...item.media!, present: false } },
      { ...item, media: null },
      { ...item, media: { ...item.media!, ref: "" } },
      { ...item, kind: "candidate" },
      { ...item, processing_status: "candidate" },
    ];
    // Simulate inconsistent historical rows without relaxing ingest validation.
    for (const recorded of inconsistent) {
      sqlite
        .prepare(
          "UPDATE inventory_observations SET item_json=? WHERE item_id=?",
        )
        .run(JSON.stringify(recorded), item.id);
      const media = await listInventory(db, manifest.episode.id, null, {
        group: "media",
      });
      expect(media.items).toHaveLength(0);
      expect(media.summary.groupCounts).toEqual({
        all: 1,
        media: 0,
        research: 0,
        attention: 1,
      });
      const attention = await listInventory(db, manifest.episode.id, null, {
        group: "attention",
      });
      expect(attention.items).toHaveLength(1);
    }
  });
  it("routes group filters and rejects invalid or duplicate group selectors", async () => {
    await accept();
    const env = { APP_ENV: "local", LOCAL_DEMO: "true", DB: db } as Env;
    const read = (params: string) =>
      worker.fetch(
        new Request(
          `http://localhost/api/inventory?episodeNumber=127&${params}`,
        ),
        env,
      );
    const media = await read("group=media");
    expect(media.status).toBe(200);
    expect(await media.json()).toMatchObject({
      filters: { group: "media" },
      summary: { totalItems: 1, matchedItems: 0 },
      items: [],
    });
    const attention = await read("group=attention&status=capture_required");
    expect(attention.status).toBe(200);
    expect(await attention.json()).toMatchObject({
      filters: { group: "attention" },
      summary: { totalItems: 1, matchedItems: 1 },
    });
    for (const params of [
      "group=unsupported",
      "group=collected",
      "group=",
      "group=all&group=attention",
    ])
      expect((await read(params)).status).toBe(422);
  });
  it("keeps source and episode isolation for counts, filters and receipts", async () => {
    const receipt = await accept();
    const otherEpisode = await inventoryEpisodeId(128);
    const manifest = changed();
    manifest.episode = { ...manifest.episode, id: otherEpisode, number: 128 };
    manifest.items = syntheticItems(3);
    await accept(manifest, db, {
      ...grant,
      episodeId: otherEpisode,
      episodeNumber: 128,
    });
    sqlite
      .prepare(
        `INSERT INTO inventory_snapshots
      SELECT 'synthetic-other-receipt','nomad:other',episode_id,digest,scan_id,sequence,
        envelope_hash,payload_hash,observed_ms,accepted_at,manifest_json,receipt_json
      FROM inventory_snapshots WHERE receipt_id=?`,
      )
      .run(receipt.receipt_id);
    sqlite
      .prepare(
        "INSERT INTO inventory_items SELECT 'nomad:other',episode_id,item_id FROM inventory_items WHERE source_id=? AND episode_id=?",
      )
      .run("nomad:number-one", example.episode.id);
    sqlite
      .prepare(
        `INSERT INTO inventory_observations
      SELECT 'synthetic-other-receipt','nomad:other',episode_id,item_id,observed_ms,sequence,item_json
      FROM inventory_observations WHERE receipt_id=?`,
      )
      .run(receipt.receipt_id);
    const view = await listInventory(db, example.episode.id);
    expect(view.summary.totalItems).toBe(1);
    expect(view.recentReceipts).toHaveLength(1);
    expect(view.latestReceipt?.receipt_id).toBe(receipt.receipt_id);
    expect((await listInventory(db, otherEpisode)).summary.totalItems).toBe(3);
    const absent = await listInventory(db, await inventoryEpisodeId(129));
    expect(absent.summary.totalItems).toBe(0);
    expect(absent.summary.matchedItems).toBe(0);
    expect(absent.latestReceipt).toBeNull();
    expect(absent.latestReceivedAt).toBeNull();
    expect(absent.latestObservedAt).toBeNull();
  });
  it("distinguishes late receipt arrival from the latest sequence and source clock", async () => {
    const newer = changed("a", "2026-10-12T09:00:00Z");
    newer.snapshot.complete = false;
    newer.items[0].processing_status = "failed";
    const latest = await accept(newer, db, grant, { sequence: 100 });
    const older = transport(copy(), { sequence: 1 });
    await acceptInventory(db, older, older.scan_id, grant, now + 1000);
    const view = await listInventory(db, example.episode.id);
    expect(view.latestReceipt?.receipt_id).toBe(latest.receipt_id);
    expect(view.latestReceipt?.complete).toBe(false);
    expect(view.latestObservedAt).toBe(
      new Date(newer.observed_at).toISOString(),
    );
    expect(view.latestReceivedAt).toBe(new Date(now + 1000).toISOString());
    expect(view.latestReceipt?.scanFinishedAt).toBe(newer.scan_finished_at);
    expect(view.items[0].variants[0]).toMatchObject({
      sequence: 100,
      receivedAt: latest.accepted_at,
      observedAt: new Date(newer.observed_at).toISOString(),
      receiptComplete: false,
      receiptScope: latest.scope,
    });
    expect(view.summary.statusCounts.failed).toBe(1);
  });
  it.each([
    { group: "ready" },
    { group: "" },
    { group: "collected" },
    { group: "all' OR 1=1 --" },
    { status: "ready" },
    { status: "" },
    { query: "x".repeat(201) },
    { query: "synthetic\n" },
    { query: "synthetic\u202e" },
  ])(
    "rejects unsupported filters before touching the DB: %j",
    async (options) => {
      const prepare = vi.fn();
      await expect(
        listInventory(
          { prepare } as unknown as D1Database,
          example.episode.id,
          null,
          options,
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(prepare).not.toHaveBeenCalled();
    },
  );
  it("derives exact inventory identities for selected workspace numbers", async () => {
    expect(
      await inventoryEpisodeSelection(new URLSearchParams("episodeNumber=127")),
    ).toEqual({ episodeId: example.episode.id, episodeNumber: 127 });
    expect(
      await inventoryEpisodeSelection(
        new URLSearchParams({ episodeId: example.episode.id }),
      ),
    ).toEqual({ episodeId: example.episode.id, episodeNumber: null });
    expect(
      await inventoryEpisodeSelection(new URLSearchParams("episodeNumber=128")),
    ).toEqual({ episodeId: await inventoryEpisodeId(128), episodeNumber: 128 });
    await expect(
      inventoryEpisodeSelection(
        new URLSearchParams({
          episodeNumber: "127",
          episodeId: await inventoryEpisodeId(128),
        }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "INVENTORY_EPISODE_MISMATCH",
    });
  });
  it.each(["", "0", "-1", "127.0", "00127", "1e2", "1000000"])(
    "rejects a noncanonical episode number: %s",
    async (value) => {
      await expect(
        inventoryEpisodeSelection(
          new URLSearchParams({ episodeNumber: value }),
        ),
      ).rejects.toMatchObject({ status: 422 });
    },
  );
  it.each(["episodeNumber", "episodeId", "after", "group", "status", "q"])(
    "rejects duplicate query parameters: %s",
    async (name) => {
      const params = new URLSearchParams("episodeNumber=127");
      params.set(name, "one");
      params.append(name, "two");
      await expect(inventoryEpisodeSelection(params)).rejects.toMatchObject({
        status: 422,
      });
    },
  );
  it("reports only the explicit receiver gate, preserving disabled-by-default reads", async () => {
    const paused = await listInventory(db, example.episode.id);
    expect(paused.ingestion).toBe("disabled");
    expect(paused.ingestionPaused).toBe(true);
    const gateOpen = await listInventory(db, example.episode.id, null, {
      ingestionEnabled: true,
    });
    expect(gateOpen.ingestion).toBe("enabled");
    expect(gateOpen.ingestionPaused).toBe(false);
  });
  it("serves the independent pilot scope through owner read routing without enabling ingestion", async () => {
    await accept();
    const env = {
      APP_ENV: "local",
      LOCAL_DEMO: "true",
      DB: db,
      INVENTORY_INGEST_ENABLED: "false",
    } as Env;
    const response = await worker.fetch(
      new Request(
        "http://localhost/api/inventory?episodeNumber=127&status=capture_required",
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      episodeId: example.episode.id,
      episodeNumber: 127,
      ingestion: "disabled",
      ingestionPaused: true,
      summary: { totalItems: 1, matchedItems: 1 },
    });
    const unmapped = await worker.fetch(
      new Request("http://localhost/api/inventory?episodeNumber=128"),
      env,
    );
    expect(unmapped.status).toBe(200);
    expect(await unmapped.json()).toMatchObject({
      episodeNumber: 128,
      episodeId: await inventoryEpisodeId(128),
      items: [],
      summary: { totalItems: 0 },
      ingestion: "disabled",
    });
  });
});
describe("HTTP fail-closed boundary", () => {
  it.each(["POST", "GET", "OPTIONS"])(
    "never accepts owner, demo, or bearer authentication for producer %s",
    async (method) => {
      const prepare = vi.fn(() => {
        throw new Error("must not touch DB");
      });
      const env = {
        APP_ENV: "local",
        LOCAL_DEMO: "true",
        DB: { prepare },
      } as unknown as Env;
      const response = await worker.fetch(
        new Request("http://localhost/api/v1/number-one/inventory-snapshots", {
          method,
          headers: {
            Authorization: "Bearer SYNTHETIC",
            "Cf-Access-Jwt-Assertion": "SYNTHETIC",
          },
        }),
        env,
      );
      expect(response.status).toBe(503);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("INVENTORY_INGESTION_DISABLED");
      expect(prepare).not.toHaveBeenCalled();
    },
  );
  it("keeps the proposed v2 transport route disabled", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/api/v2/number-one/inventory-snapshots", {
        method: "POST",
      }),
      { APP_ENV: "local" } as Env,
    );
    expect(response.status).toBe(503);
  });
  it("keeps owner inventory reads behind authentication", async () => {
    const response = await worker.fetch(
      new Request(
        "https://example.com/api/inventory?episodeId=" + example.episode.id,
      ),
      { APP_ENV: "production", DB: db } as Env,
    );
    expect(response.status).toBe(503);
  });
  it("rejects a missing owner JWT with configured Access before reading inventory", async () => {
    const prepare = vi.fn(() => {
      throw new Error("must not touch DB");
    });
    const env = {
      APP_ENV: "production",
      APP_ORIGIN: "https://example.com",
      ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
      ACCESS_AUD: "synthetic-audience",
      OWNER_EMAIL: "owner@example.com",
      DB: { prepare },
    } as unknown as Env;
    const response = await worker.fetch(
      new Request(
        "https://example.com/api/inventory?episodeId=" + example.episode.id,
      ),
      env,
    );
    expect(response.status).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("bounds streamed JSON even without Content-Length", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(INVENTORY_MAX_BYTES + 1));
        controller.close();
      },
    });
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readInventoryBody(request)).rejects.toMatchObject({
      status: 413,
    });
  });
  it("rejects malformed UTF-8 and compressed/non-JSON requests", async () => {
    await expect(
      readInventoryBody(
        new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: new Uint8Array([0xff]),
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readInventoryBody(
        new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readInventoryBody(
        new Request("https://example.com", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
          },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
});
