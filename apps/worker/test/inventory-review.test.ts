import { afterEach, beforeEach, beforeAll, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPair, SignJWT } from "jose";
import { acceptInventory, listInventory } from "../src/inventory/store";
import {
  saveInventoryReview,
  inventoryVersion,
  inventoryVersionBasis,
  versionBasisSql,
} from "../src/inventory/review";
import {
  semanticHash,
  type InventoryManifest,
  type InventoryItem,
} from "../src/inventory/contract";
import worker from "../src/index";
import { csrfToken } from "../src/auth";
import type { Env } from "../src/env";
const keys = vi.hoisted(() => ({ public: undefined as CryptoKey | undefined }));
vi.mock("jose", async () => ({
  ...(await vi.importActual<typeof import("jose")>("jose")),
  createRemoteJWKSet: vi.fn(() => async () => keys.public),
}));
let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys.public = pair.publicKey;
});
const template = JSON.parse(
  readFileSync(
    new URL("./fixtures/inventory.example.json", import.meta.url),
    "utf8",
  ),
) as InventoryManifest;
let sqlite: DatabaseSync, db: D1Database, sequence: number;
const now = Date.parse("2026-10-13T00:00:00Z");
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sequence = 0;
  for (const name of [
    "0011_number_one_inventory.sql",
    "0013_inventory_review.sql",
  ])
    sqlite.exec(
      readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"),
    );
  const prepare = (sql: string) => {
    let values: (string | number | null)[] = [];
    const s = {
      bind: (...args: (string | number | null)[]) => {
        values = args;
        return s;
      },
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => sqlite.prepare(sql).run(...values),
    };
    return s;
  };
  db = {
    prepare,
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
});
afterEach(() => sqlite.close());
function media(index: number, ref: string): InventoryItem {
  return {
    id: "item_" + index.toString(16).padStart(64, "0"),
    kind: "media",
    media: {
      ref,
      present: true,
      size_bytes: 1000,
      modified_at: "2026-10-12T01:00:00Z",
      duration_seconds: 60,
    },
    observations: [],
    origins: [],
    processing_status: "captured_observed",
    ready: false,
    capture_evidence: [
      {
        artifact: "set-aside/json/synthetic.capture.json",
        matches_observed_size: true,
        content_hash_verified: false,
        streams_reprobed: false,
        producer_sha256: "a".repeat(64),
      },
    ],
  };
}

async function accept(
  items: InventoryItem[],
  time = new Date(now + sequence * 60000).toISOString(),
) {
  const manifest = structuredClone(template);
  manifest.items = items;
  manifest.observed_at = time;
  manifest.scan_finished_at = time;
  manifest.idempotency_digest = "sha256:" + (await semanticHash(manifest));
  const scan =
    "00000000-0000-4000-8000-" + (++sequence).toString().padStart(12, "0");
  return acceptInventory(
    db,
    {
      schema: "number-one-inventory-envelope/v2",
      scan_id: scan,
      sequence,
      manifest,
    },
    scan,
    {
      sourceId: manifest.source_id,
      episodeId: manifest.episode.id,
      episodeNumber: 127,
      scope: "inventory:write",
      expiresAt: now + 86400000,
      allowEditorialContext: true,
      originHosts: ["www.youtube.com", "example.com"],
    },
    now + sequence,
  );
}
const episode = template.episode.id;
async function save(
  item: InventoryItem,
  status = "approved",
  revision = 0,
  extra: Record<string, unknown> = {},
) {
  return saveInventoryReview(
    db,
    {
      operationId: crypto.randomUUID(),
      episodeNumber: 127,
      itemId: item.id,
      expectedRevision: revision,
      expectedVersion: await inventoryVersion(item),
      action: "decision",
      notes: "Persistent private note",
      status,
      reason: "Complete useful point",
      ...extra,
    },
    "synthetic-owner",
    now,
  );
}
it("filename sort runs over the entire result set, groups literal folders and seeks tied names", async () => {
  const items = Array.from({ length: 45 }, (_, i) =>
    media(
      i + 1,
      `${i % 2 ? "02-TOPIC" : "01-MACO"}/${(44 - i).toString().padStart(2, "0")}-café%20literal.mp4`,
    ),
  );
  await accept(items);
  const found: InventoryItem[] = [];
  let cursor: string | null = null;
  do {
    const view = await listInventory(db, episode, cursor, {
      sort: "filename",
      direction: "asc",
      groupFolders: true,
    });
    found.push(...view.items.map((v) => v.variants[0].item));
    cursor = view.nextCursor;
  } while (cursor);
  expect(found).toHaveLength(45);
  expect(new Set(found.map((v) => v.id)).size).toBe(45);
  expect(found.map((v) => v.media!.ref)).toEqual(
    items.map((v) => v.media!.ref).sort(),
  );
  expect(found[0].media!.ref).toContain("01-MACO/");
  expect(found[0].media!.ref).toContain("%20");
});
it("ties and null filenames paginate in both directions without duplicates", async () => {
  const items = Array.from({ length: 42 }, (_, i) =>
    media(i + 1, `${i}/same.mp4`),
  );
  const candidate = structuredClone(template.items[0]);
  candidate.id = "item_" + "f".repeat(64);
  items.push(candidate);
  await accept(items);
  for (const direction of ["asc", "desc"]) {
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const view = await listInventory(db, episode, cursor, {
        sort: "filename",
        direction,
      });
      ids.push(...view.items.map((v) => v.id));
      cursor = view.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(43);
    expect(ids.at(-1)).toBe(candidate.id);
  }
});
it("first-observed sorting preserves producer dates and truthful scan fallback", async () => {
  const older = media(1, "older.mp4"),
    later = media(2, "later.mp4");
  older.producer_record = {
    clip_id: "src-old",
    record_kind: "processing-history",
    first_seen_at: "2026-10-08T16:03:06Z",
    source_signature: "100:123",
    parent_clip_id: null,
  };
  await accept([later, older]);
  const view = await listInventory(db, episode, null, {
    sort: "first_observed",
  });
  expect(view.items.map((v) => v.id)).toEqual([older.id, later.id]);
  expect(view.items[0].firstObservedAt).toBe("2026-10-08T16:03:06.000Z");
  expect(view.items[1].firstObservedAt).toBe(new Date(now).toISOString());
});
it("cursor is bound to filters and freezes observations while newer scans arrive", async () => {
  const items = Array.from({ length: 25 }, (_, i) =>
    media(i + 1, `${i.toString().padStart(2, "0")}.mp4`),
  );
  await accept(items);
  const page = await listInventory(db, episode, null, { sort: "filename" });
  await expect(
    listInventory(db, episode, page.nextCursor, { sort: "first_observed" }),
  ).rejects.toMatchObject({ status: 422 });
  const newer = structuredClone(items);
  newer[24].media!.ref = "00-new-first.mp4";
  await accept(newer);
  const next = await listInventory(db, episode, page.nextCursor, {
    sort: "filename",
  });
  expect(next.items[4].variants[0].item.media!.ref).toBe("24.mp4");
});
it("SQL version basis exactly matches the persisted metadata basis", async () => {
  const item = media(1, "clip.mp4");
  await accept([item]);
  const row = sqlite
    .prepare(
      `SELECT ${versionBasisSql("o")} basis FROM inventory_observations o`,
    )
    .get();
  expect(row?.basis).toBe(inventoryVersionBasis(item));
});
it("approval and notes persist on reload and Unreviewed filtering happens before pagination", async () => {
  const items = Array.from({ length: 25 }, (_, i) =>
    media(i + 1, `${i.toString().padStart(2, "0")}.mp4`),
  );
  await accept(items);
  await save(items[0]);
  await save(items[1]);
  const view = await listInventory(db, episode, null, {
    sort: "filename",
    review: "unreviewed",
  });
  expect(view.summary.matchedItems).toBe(23);
  expect(view.items).toHaveLength(20);
  expect(view.items[0].id).toBe(items[2].id);
  const all = await listInventory(db, episode, null, { sort: "filename" });
  expect(all.items[0].review).toMatchObject({
    effectiveStatus: "approved",
    notes: "Persistent private note",
    revision: 1,
  });
});
it("changed media invalidates approval, retains notes and note-only save cannot reapprove", async () => {
  const item = media(1, "clip.mp4");
  await accept([item]);
  await save(item);
  const changed = structuredClone(item);
  changed.media!.size_bytes! += 1;
  await accept([changed]);
  const view = await listInventory(db, episode);
  expect(view.items[0].review).toMatchObject({
    status: "approved",
    effectiveStatus: "unreviewed",
    changed: true,
    notes: "Persistent private note",
  });
  const result = await saveInventoryReview(
    db,
    {
      operationId: crypto.randomUUID(),
      episodeNumber: 127,
      itemId: item.id,
      expectedRevision: 1,
      expectedVersion: await inventoryVersion(changed),
      action: "note",
      notes: "Updated note",
    },
    "synthetic-owner",
    now,
  );
  expect(result).toMatchObject({
    status: "approved",
    effectiveStatus: "unreviewed",
    changed: true,
    revision: 2,
  });
});
it("optimistic concurrency rejects stale review/version writes without overwriting", async () => {
  const item = media(1, "clip.mp4");
  await accept([item]);
  await save(item);
  await expect(save(item, "rejected", 0)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    save(item, "rejected", 1, { expectedVersion: "a".repeat(64) }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await listInventory(db, episode)).items[0].review?.status).toBe(
    "approved",
  );
});
it("immutable operation replay acknowledges once and detects changed payload", async () => {
  const item = media(1, "clip.mp4");
  await accept([item]);
  const operationId = crypto.randomUUID();
  const response = await save(item, "approved", 0, { operationId });
  expect(await save(item, "approved", 0, { operationId })).toEqual(response);
  await expect(
    save(item, "rejected", 0, { operationId }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    sqlite.prepare("SELECT count(*) n FROM inventory_review_operations").get()
      ?.n,
  ).toBe(1);
});
it("existing producer UID is reused; legacy overlay survives later producer metadata", async () => {
  const item = media(1, "clip.mp4");
  await accept([item]);
  await save(item);
  const adapted = structuredClone(item);
  adapted.producer_record = {
    clip_id: "src-processing",
    clip_uid: "n1-layout",
    record_kind: "processing-history",
    first_seen_at: null,
    source_signature: "100:123",
    parent_clip_id: null,
  };
  await accept([adapted]);
  expect(
    (await listInventory(db, episode)).items[0].review?.effectiveStatus,
  ).toBe("approved");
  await save(adapted, "approved", 1);
  const row = sqlite
    .prepare("SELECT review_key,producer_key FROM inventory_reviews")
    .get();
  expect(row).toMatchObject({
    review_key: item.id,
    producer_key: "number-one:n1-layout",
  });
});
it("ambiguous producer IDs are never merged or approved implicitly", async () => {
  const a = media(1, "a.mp4"),
    b = media(2, "b.mp4");
  for (const item of [a, b])
    item.producer_record = {
      clip_id: "src-duplicate",
      record_kind: "processing-history",
      first_seen_at: null,
      source_signature: null,
      parent_clip_id: null,
    };
  await accept([a, b]);
  await expect(save(a)).rejects.toMatchObject({ status: 409 });
  expect(
    (await listInventory(db, episode)).items.every((v) => v.identityConflict),
  ).toBe(true);
});
it("saved approval becomes unreviewed in SQL filters when another current file claims its producer identity", async () => {
  const a = media(1, "a.mp4"),
    b = media(2, "b.mp4");
  for (const item of [a, b])
    item.producer_record = {
      clip_id: "src-duplicate",
      record_kind: "processing-history",
      first_seen_at: null,
      source_signature: null,
      parent_clip_id: null,
    };
  await accept([a]);
  await save(a);
  await accept([b]);
  expect(
    (await listInventory(db, episode, null, { review: "approved" })).items,
  ).toHaveLength(0);
  const unreviewed = await listInventory(db, episode, null, {
    review: "unreviewed",
  });
  expect(unreviewed.items).toHaveLength(2);
  expect(
    unreviewed.items.every(
      (item) =>
        item.identityConflict && item.review?.effectiveStatus === "unreviewed",
    ),
  ).toBe(true);
});
it("atomic save rejects producer duplicates arriving after preflight without recording an operation", async () => {
  const a = media(1, "a.mp4"),
    b = media(2, "b.mp4");
  for (const item of [a, b])
    item.producer_record = {
      clip_id: "src-race",
      record_kind: "processing-history",
      first_seen_at: null,
      source_signature: null,
      parent_clip_id: null,
    };
  await accept([a]);
  const originalBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async (...args: Parameters<D1Database["batch"]>) => {
    if (!injected) {
      injected = true;
      await accept([b]);
    }
    return originalBatch(...args);
  };
  await expect(save(a)).rejects.toMatchObject({ status: 409 });
  expect(
    sqlite.prepare("SELECT count(*) n FROM inventory_reviews").get()?.n,
  ).toBe(0);
  expect(
    sqlite.prepare("SELECT count(*) n FROM inventory_review_operations").get()
      ?.n,
  ).toBe(0);
});
it("rejection/cut intentions and long or unknown approvals require reasons", async () => {
  const item = media(1, "clip.mp4");
  item.media!.duration_seconds = 181;
  await accept([item]);
  for (const status of ["approved", "rejected", "cut_down"])
    await expect(save(item, status, 0, { reason: "" })).rejects.toMatchObject({
      status: 422,
    });
  expect(await save(item)).toMatchObject({ status: "approved" });
  expect(item.ready).toBe(false);
});
it("new owner mutation rejects missing/service auth and requires exact origin plus CSRF", async () => {
  const item = media(1, "clip.mp4");
  await accept([item]);
  const env = {
    DB: db,
    APP_ENV: "production",
    APP_ORIGIN: "https://owner.example.com",
    ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    OWNER_EMAIL: "owner@example.com",
    CSRF_SECRET: "synthetic-test-only-at-least-24-chars",
  } as Env;
  const seconds = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    iss: "https://synthetic.cloudflareaccess.com",
    aud: env.ACCESS_AUD,
    sub: "synthetic-owner",
    email: env.OWNER_EMAIL,
    iat: seconds,
    exp: seconds + 300,
  })
    .setProtectedHeader({ alg: "RS256" })
    .sign(privateKey);
  const payload = {
    operationId: crypto.randomUUID(),
    episodeNumber: 127,
    itemId: item.id,
    expectedRevision: 0,
    expectedVersion: await inventoryVersion(item),
    action: "note",
    notes: "Owner note",
  };
  const request = async (headers: Record<string, string>) =>
    worker.fetch(
      new Request(env.APP_ORIGIN + "/api/inventory/review", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      }),
      env,
    );
  expect((await request({})).status).toBe(401);
  const serviceJwt = await new SignJWT({
    iss: "https://synthetic.cloudflareaccess.com",
    aud: env.ACCESS_AUD,
    sub: "",
    common_name: "synthetic-service",
    type: "app",
    iat: seconds,
    exp: seconds + 300,
  })
    .setProtectedHeader({ alg: "RS256" })
    .sign(privateKey);
  expect(
    (await request({ "Cf-Access-Jwt-Assertion": serviceJwt })).status,
  ).toBe(401);
  expect((await request({ "Cf-Access-Jwt-Assertion": jwt })).status).toBe(403);
  expect(
    (
      await request({
        "Cf-Access-Jwt-Assertion": jwt,
        Origin: env.APP_ORIGIN!,
        "X-CSRF-Token": await csrfToken("synthetic-owner", env, false),
      })
    ).status,
  ).toBe(200);
});
