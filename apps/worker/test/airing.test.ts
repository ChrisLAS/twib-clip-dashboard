import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { seedDemo } from "../src/fixtures";
import { getRender } from "../src/store";
import {
  airingInputSchema,
  airingDecisionSchema,
  airingSourceFingerprint,
  ingestAiringEvidence,
  listAiringEvidence,
  decideAiringEvidence,
} from "../src/airing";
import type { AiringEvidenceInput } from "@twib/shared";
let sqlite: DatabaseSync, db: D1Database;
let hook: (() => void) | undefined;
let ingestHook: (() => void) | undefined;
let loseDecisionResponse = false;
class Statement {
  values: (string | number | null)[] = [];
  constructor(private sql: string) {}
  bind(...v: (string | number | null)[]) {
    this.values = v;
    return this;
  }
  async first<T>() {
    return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null;
  }
  async all<T>() {
    return { results: sqlite.prepare(this.sql).all(...this.values) as T[] };
  }
  async run() {
    if (this.sql.startsWith("INSERT INTO airing_events") && hook) {
      const h = hook;
      hook = undefined;
      h();
    }
    if (
      this.sql.startsWith("INSERT OR IGNORE INTO airing_evidence") &&
      ingestHook
    ) {
      const h = ingestHook;
      ingestHook = undefined;
      h();
    }
    const result = sqlite.prepare(this.sql).run(...this.values);
    if (
      this.sql.startsWith("INSERT INTO airing_events") &&
      loseDecisionResponse
    ) {
      loseDecisionResponse = false;
      throw new Error("Lost confirmation response");
    }
    return result;
  }
}
const ep = "b".repeat(64),
  transcript = "c".repeat(64);
beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort())
    sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
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
  await seedDemo(db);
  sqlite
    .prepare(
      "UPDATE renders SET data=json_set(data,'$.artifactHash',?) WHERE id='render-topic-one-v1'",
    )
    .run("a".repeat(64));
  sqlite
    .prepare(
      "INSERT INTO publication_episodes(feed_id,guid,episode_id,transcript_asset_key,data) VALUES(?,?,?,?,?)",
    )
    .run(
      "feed",
      "guid",
      "ep-demo",
      "test-transcript",
      JSON.stringify({
        editionFingerprint: ep,
        transcriptHash: transcript,
        feedId: "feed",
        guid: "guid",
      }),
    );
  sqlite
    .prepare(
      "INSERT INTO publication_assets(asset_key,kind,url,state,hash) VALUES(?,?,?,?,?)",
    )
    .run("rss", "rss", "https://example.com/feed", "ready", "f".repeat(64));
  sqlite
    .prepare(
      "INSERT INTO publication_assets(asset_key,kind,url,state,hash) VALUES(?,?,?,?,?)",
    )
    .run(
      "test-transcript",
      "transcript",
      "https://example.com/transcript",
      "ready",
      transcript,
    );
  hook = undefined;
  ingestHook = undefined;
  loseDecisionResponse = false;
});
afterEach(() => sqlite.close());
async function input(): Promise<AiringEvidenceInput> {
  const render = await getRender(db, "render-topic-one-v1");
  return {
    idempotencyKey: "candidate-request",
    renderId: render.id,
    episodeId: "ep-demo",
    renderArtifactHash: render.artifactHash!,
    sourceFingerprint: await airingSourceFingerprint(render),
    episodeEditionFingerprint: ep,
    episodeTranscriptHash: transcript,
    algorithmVersion: "bounded-passage-v1",
    status: "UNKNOWN",
    reason: "no_distinctive_match",
    sourceCoordinateSpace: "clip_render",
    exactRenderIdentity: "not_established_by_text",
    searchComplete: true,
    passages: [],
  };
}
describe("airing evidence", () => {
  it("validates absence as unknown and refuses text-alone confirmations", async () => {
    const v = await input();
    expect(airingInputSchema.safeParse(v).success).toBe(true);
    expect(
      airingInputSchema.safeParse({ ...v, status: "CANDIDATE" }).success,
    ).toBe(false);
    expect(
      airingDecisionSchema.safeParse({
        expectedRevision: 0,
        idempotencyKey: "decision-request",
        decision: "full",
        note: "",
        verification: "none",
      }).success,
    ).toBe(false);
  });
  it("persists once, reconciles request retries and retains owner scope", async () => {
    const v = await input();
    const saved = await ingestAiringEvidence(db, v, "owner");
    expect(await ingestAiringEvidence(db, v, "owner")).toEqual(saved);
    expect(
      (await listAiringEvidence(db, v.renderId, "owner")).evidence,
    ).toHaveLength(1);
    expect(
      (await listAiringEvidence(db, v.renderId, "other")).evidence,
    ).toHaveLength(0);
    await expect(
      ingestAiringEvidence(db, { ...v, searchComplete: false }, "owner"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_REUSE" });
  });
  it("requires current render and edition; stale rows remain historical", async () => {
    const v = await input();
    await ingestAiringEvidence(db, v, "owner");
    sqlite
      .prepare(
        "UPDATE publication_episodes SET data=json_set(data,'$.editionFingerprint',?)",
      )
      .run("d".repeat(64));
    const row = (await listAiringEvidence(db, v.renderId, "owner")).evidence[0];
    expect(row.freshness).toBe("stale");
    await expect(
      decideAiringEvidence(
        db,
        row.id,
        {
          expectedRevision: 0,
          idempotencyKey: "confirm-stale",
          decision: "full",
          note: "verified",
          verification: "listened_compared_exact_render",
        },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "STALE_EVIDENCE" });
  });
  it("records explicit partial confirmation and undo with immutable history", async () => {
    const v = await input();
    await ingestAiringEvidence(db, v, "owner");
    const row = (await listAiringEvidence(db, v.renderId, "owner")).evidence[0];
    const decision = {
      expectedRevision: 0,
      idempotencyKey: "confirm-partial",
      decision: "partial" as const,
      note: "Only first passage was used",
      verification: "listened_compared_exact_render" as const,
    };
    const saved = await decideAiringEvidence(db, row.id, decision, "owner");
    expect(await decideAiringEvidence(db, row.id, decision, "owner")).toEqual(
      saved,
    );
    expect(
      (await listAiringEvidence(db, v.renderId, "owner")).evidence[0].decision,
    ).toBe("partial");
    await decideAiringEvidence(
      db,
      row.id,
      {
        ...decision,
        expectedRevision: 1,
        idempotencyKey: "undo-confirmation",
        decision: "undo",
        verification: "none",
      },
      "owner",
    );
    expect(
      (await listAiringEvidence(db, v.renderId, "owner")).evidence[0].decision,
    ).toBe("unknown");
    expect(() => sqlite.exec("DELETE FROM airing_events")).toThrow(/immutable/);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM airing_events").get()?.n,
    ).toBe(2);
  });
  it("atomically rejects an episode edition race during confirmation", async () => {
    const v = await input();
    await ingestAiringEvidence(db, v, "owner");
    const row = (await listAiringEvidence(db, v.renderId, "owner")).evidence[0];
    hook = () =>
      sqlite
        .prepare(
          "UPDATE publication_episodes SET data=json_set(data,'$.editionFingerprint',?)",
        )
        .run("e".repeat(64));
    await expect(
      decideAiringEvidence(
        db,
        row.id,
        {
          expectedRevision: 0,
          idempotencyKey: "racing-confirm",
          decision: "full",
          note: "",
          verification: "listened_compared_exact_render",
        },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM airing_events").get()?.n,
    ).toBe(0);
  });
});

describe("airing adversarial guards", () => {
  it("parses direct ingest calls instead of trusting TypeScript", async () => {
    const v = await input();
    await expect(
      ingestAiringEvidence(db, { ...v, status: "CANDIDATE" }, "owner"),
    ).rejects.toThrow();
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM airing_evidence").get()?.n,
    ).toBe(0);
  });
  it("parses direct confirmation calls and refuses text-only full use", async () => {
    const v = await input();
    await ingestAiringEvidence(db, v, "owner");
    const row = (await listAiringEvidence(db, v.renderId, "owner")).evidence[0];
    await expect(
      decideAiringEvidence(
        db,
        row.id,
        {
          expectedRevision: 0,
          idempotencyKey: "invalid-confirm1",
          decision: "full",
          note: "",
          verification: "none",
        },
        "owner",
      ),
    ).rejects.toThrow();
  });
  it("separates identical evidence between owner principals", async () => {
    const v = await input();
    await ingestAiringEvidence(db, v, "owner");
    await ingestAiringEvidence(
      db,
      { ...v, idempotencyKey: "other-owner-key" },
      "other",
    );
    const a = (await listAiringEvidence(db, v.renderId, "owner")).evidence[0];
    const b = (await listAiringEvidence(db, v.renderId, "other")).evidence[0];
    expect(a.id).not.toBe(b.id);
  });
  it("rejects another owner's global operation key without pretending uncertainty", async () => {
    const v = await input();
    await ingestAiringEvidence(db, v, "owner");
    await expect(ingestAiringEvidence(db, v, "other")).rejects.toMatchObject({
      code: "IDEMPOTENCY_REUSE",
    });
  });
  it("atomically rejects source mapping changes during confirmation", async () => {
    const v = await input();
    await ingestAiringEvidence(db, v, "owner");
    const row = (await listAiringEvidence(db, v.renderId, "owner")).evidence[0];
    hook = () =>
      sqlite
        .prepare(
          "UPDATE renders SET data=json_set(data,'$.recipeHash','new-recipe') WHERE id=?",
        )
        .run(v.renderId);
    await expect(
      decideAiringEvidence(
        db,
        row.id,
        {
          expectedRevision: 0,
          idempotencyKey: "racing-source-key",
          decision: "full",
          note: "",
          verification: "listened_compared_exact_render",
        },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM airing_events").get()?.n,
    ).toBe(0);
  });
  it("atomically rejects edition replacement during candidate insertion", async () => {
    const v = await input();
    ingestHook = () =>
      sqlite
        .prepare(
          "UPDATE publication_episodes SET data=json_set(data,'$.editionFingerprint',?)",
        )
        .run("f".repeat(64));
    await expect(ingestAiringEvidence(db, v, "owner")).rejects.toThrow();
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM airing_evidence").get()?.n,
    ).toBe(0);
  });
  it("reconciles a lost confirmation response using its original receipt", async () => {
    const v = await input();
    await ingestAiringEvidence(db, v, "owner");
    const row = (await listAiringEvidence(db, v.renderId, "owner")).evidence[0];
    loseDecisionResponse = true;
    const decision = {
      expectedRevision: 0,
      idempotencyKey: "lost-response-key",
      decision: "partial" as const,
      note: "Exact playback compared",
      verification: "listened_compared_exact_render" as const,
    };
    const saved = await decideAiringEvidence(db, row.id, decision, "owner");
    expect(await decideAiringEvidence(db, row.id, decision, "owner")).toEqual(
      saved,
    );
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM airing_events").get()?.n,
    ).toBe(1);
  });
});
