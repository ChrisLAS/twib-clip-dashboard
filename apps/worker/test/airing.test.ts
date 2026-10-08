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

// Exact-render transcripts are a separate immutable observation, not render mapping edits.
import {
  importRenderTranscriptAsset,
  prepareRenderTranscriptAsset,
  getRenderTranscriptAsset,
  selectRenderTranscriptAsset,
} from "../src/render-transcripts";
import type {
  RenderTranscriptInput,
  RenderTranscriptAsset,
} from "../../../packages/shared/src/render-transcripts";
function transcriptInput(
  text = "Machine speech words",
  key = "transcript-request",
): RenderTranscriptInput {
  return {
    idempotencyKey: key,
    renderId: "render-topic-one-v1",
    mediaSha256: "a".repeat(64),
    origin: "machine_asr",
    alignment: "exact_render",
    textAccuracy: "unverified",
    sourceMapping: "unknown",
    cues: [{ id: "asr-1", startMs: 0, endMs: 1000, text }],
  };
}
function insertAsset(asset: RenderTranscriptAsset, owner = "owner") {
  sqlite
    .prepare(
      "INSERT INTO render_transcript_assets(id,owner,render_id,media_sha256,duration_ms,transcript_hash,asset_hash,created_at,data) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      asset.id,
      owner,
      asset.renderId,
      asset.mediaSha256,
      asset.durationMs,
      asset.transcriptHash,
      asset.assetHash,
      asset.createdAt,
      JSON.stringify(asset),
    );
}
async function assetCandidate(): Promise<AiringEvidenceInput> {
  const asset = await importRenderTranscriptAsset(
    db,
    transcriptInput(),
    "owner",
  );
  const render = await getRender(db, asset.renderId);
  return {
    ...(await input()),
    sourceFingerprint: await airingSourceFingerprint(render, asset),
    sourceTranscriptAssetId: asset.id,
    sourceTranscriptAssetHash: asset.assetHash,
    status: "CANDIDATE",
    reason: "passages_require_verification",
    passages: [
      {
        sourceRange: { startMs: 0, endMs: 1000 },
        episodeRange: { startMs: 0, endMs: 1000 },
        timingPrecision: "enclosing_cues",
        quality: "exact_normalized_passage",
        matchedTokens: 24,
        editedTokens: 0,
        distinctiveTokens: 10,
        ambiguity: "not_detected",
        sourceExcerpt: "Machine speech words",
        episodeExcerpt: "Machine speech words",
      },
    ],
  };
}
const positiveDecision = {
  expectedRevision: 0,
  idempotencyKey: "asset-decision-key",
  decision: "full" as const,
  note: "",
  verification: "listened_compared_exact_render" as const,
};
describe("exact-render transcript assets", () => {
  it("uses server canonical hashes, scoped immutable history and idempotent receipts", async () => {
    const before = await getRender(db, "render-topic-one-v1");
    const asset = await importRenderTranscriptAsset(
      db,
      transcriptInput(),
      "owner",
    );
    expect(
      await importRenderTranscriptAsset(db, transcriptInput(), "owner"),
    ).toEqual(asset);
    expect(
      await importRenderTranscriptAsset(
        db,
        transcriptInput("Machine speech words", "new-key-same-content"),
        "owner",
      ),
    ).toEqual(asset);
    expect(asset.assetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(asset.transcriptHash).not.toBe(asset.assetHash);
    expect(await getRenderTranscriptAsset(db, asset.id, "other")).toBeNull();
    expect(await getRender(db, before.id)).toEqual(before);
    expect(() =>
      sqlite
        .prepare("UPDATE render_transcript_assets SET asset_hash=? WHERE id=?")
        .run("b".repeat(64), asset.id),
    ).toThrow(/immutable/);
    expect(() =>
      sqlite
        .prepare("DELETE FROM render_transcript_assets WHERE id=?")
        .run(asset.id),
    ).toThrow(/immutable/);
    await expect(
      importRenderTranscriptAsset(
        db,
        {
          ...transcriptInput(),
          assetHash: "b".repeat(64),
        } as RenderTranscriptInput,
        "owner",
      ),
    ).rejects.toThrow();
    await expect(
      importRenderTranscriptAsset(db, transcriptInput("Changed text"), "owner"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_REUSE" });
    await expect(
      importRenderTranscriptAsset(db, transcriptInput(), "other"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_REUSE" });
  });
  it("rejects mismatched hashes, source coordinates, malformed and overlapping cue ranges", async () => {
    const v = transcriptInput();
    await expect(
      importRenderTranscriptAsset(
        db,
        { ...v, mediaSha256: "b".repeat(64) },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "RENDER_HASH_MISMATCH" });
    for (const cues of [
      [{ ...v.cues[0], startMs: -1 }],
      [{ ...v.cues[0], endMs: 0 }],
      [{ ...v.cues[0], endMs: 99999999 }],
      [v.cues[0], { ...v.cues[0], id: "asr-2", startMs: 999, endMs: 2000 }],
      [v.cues[0], { ...v.cues[0], startMs: 1000, endMs: 2000 }],
    ])
      await expect(
        importRenderTranscriptAsset(db, { ...v, cues }, "owner"),
      ).rejects.toThrow();
    await expect(
      importRenderTranscriptAsset(
        db,
        { ...v, sourceMapping: "verified" } as unknown as RenderTranscriptInput,
        "owner",
      ),
    ).rejects.toThrow();
  });
  it("allows mapping-false candidate only through a separate exact asset", async () => {
    sqlite.exec(
      "UPDATE renders SET data=json_set(data,'$.mappingVerified',json('false')) WHERE id='render-topic-one-v1'",
    );
    const v = await assetCandidate();
    expect((await getRender(db, v.renderId)).mappingVerified).toBe(false);
    await ingestAiringEvidence(db, v, "owner");
    expect(
      (await listAiringEvidence(db, v.renderId, "owner")).evidence[0].freshness,
    ).toBe("current");
    await expect(
      ingestAiringEvidence(
        db,
        { ...v, idempotencyKey: "wrong-owner-request" },
        "other",
      ),
    ).rejects.toMatchObject({ code: "STALE_EVIDENCE" });
    const legacy = {
      ...v,
      idempotencyKey: "legacy-candidate-key",
      sourceTranscriptAssetId: undefined,
      sourceTranscriptAssetHash: undefined,
      sourceFingerprint: await airingSourceFingerprint(
        await getRender(db, v.renderId),
      ),
    };
    await expect(
      ingestAiringEvidence(db, legacy, "owner"),
    ).rejects.toMatchObject({ code: "UNVERIFIED_MAPPING" });
  });
  it("orders same-timestamp corrections by insertion and does not repoint old evidence or advance dedup", async () => {
    const v = await assetCandidate();
    await ingestAiringEvidence(db, v, "owner");
    const old = await getRenderTranscriptAsset(
      db,
      v.sourceTranscriptAssetId!,
      "owner",
    );
    const render = await getRender(db, v.renderId);
    const next = await prepareRenderTranscriptAsset(
      transcriptInput("Corrected text", "next-transcript-key"),
      render,
      "owner",
    );
    next.createdAt = old!.createdAt;
    insertAsset(next);
    expect((await selectRenderTranscriptAsset(db, render, "owner"))?.id).toBe(
      next.id,
    );
    await importRenderTranscriptAsset(
      db,
      transcriptInput("Machine speech words", "repeat-older-key"),
      "owner",
    );
    expect((await selectRenderTranscriptAsset(db, render, "owner"))?.id).toBe(
      next.id,
    );
    const row = (await listAiringEvidence(db, v.renderId, "owner")).evidence[0];
    expect(row.sourceTranscriptAssetId).toBe(old!.id);
    expect(row.freshness).toBe("stale");
    await expect(
      decideAiringEvidence(db, row.id, positiveDecision, "owner"),
    ).rejects.toMatchObject({ code: "STALE_EVIDENCE" });
    await decideAiringEvidence(
      db,
      row.id,
      { ...positiveDecision, decision: "undo", verification: "none" },
      "owner",
    );
  });
  it("atomically rejects a transcript correction racing candidate insert", async () => {
    const v = await assetCandidate();
    const next = await prepareRenderTranscriptAsset(
      transcriptInput("Corrected words"),
      await getRender(db, v.renderId),
      "owner",
    );
    ingestHook = () => insertAsset(next);
    await expect(ingestAiringEvidence(db, v, "owner")).rejects.toThrow();
    expect(
      sqlite.prepare("SELECT count(*) n FROM airing_evidence").get()?.n,
    ).toBe(0);
  });
  it("atomically rejects a transcript correction racing positive decision", async () => {
    const v = await assetCandidate();
    await ingestAiringEvidence(db, v, "owner");
    const row = (await listAiringEvidence(db, v.renderId, "owner")).evidence[0];
    const next = await prepareRenderTranscriptAsset(
      transcriptInput("Corrected words"),
      await getRender(db, v.renderId),
      "owner",
    );
    hook = () => insertAsset(next);
    await expect(
      decideAiringEvidence(db, row.id, positiveDecision, "owner"),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      sqlite.prepare("SELECT count(*) n FROM airing_events").get()?.n,
    ).toBe(0);
  });
  it("database guards reject forged asset hashes and owners at ingestion", async () => {
    const v = await assetCandidate();
    await ingestAiringEvidence(db, v, "owner");
    const row = sqlite.prepare("SELECT * FROM airing_evidence").get()!;
    for (const [owner, data] of [
      ["other", v],
      ["owner", { ...v, sourceTranscriptAssetHash: "d".repeat(64) }],
    ] as const)
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO airing_evidence(id,owner,render_id,episode_id,fingerprint,data,source_snapshot) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            "forged",
            owner,
            v.renderId,
            v.episodeId,
            "forged-fp",
            JSON.stringify(data),
            row.source_snapshot!,
          ),
      ).toThrow();
  });
});

it("fences render hash changes racing transcript import and records no partial receipt", async () => {
  const racingDb = {
    ...db,
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite
        .prepare(
          "UPDATE renders SET data=json_set(data,'$.artifactHash',?) WHERE id='render-topic-one-v1'",
        )
        .run("f".repeat(64));
      return db.batch(statements);
    },
  } as unknown as D1Database;
  await expect(
    importRenderTranscriptAsset(racingDb, transcriptInput(), "owner"),
  ).rejects.toMatchObject({ code: "SAVE_UNCONFIRMED" });
  expect(
    sqlite.prepare("SELECT count(*) n FROM render_transcript_assets").get()?.n,
  ).toBe(0);
  expect(
    sqlite
      .prepare(
        "SELECT count(*) n FROM operations WHERE id='transcript-request'",
      )
      .get()?.n,
  ).toBe(0);
});
it("reconciles a lost transcript import response without duplicating or changing ownership", async () => {
  const uncertainDb = {
    ...db,
    batch: async (statements: D1PreparedStatement[]) => {
      await db.batch(statements);
      throw new Error("Lost import response");
    },
  } as unknown as D1Database;
  const asset = await importRenderTranscriptAsset(
    uncertainDb,
    transcriptInput(),
    "owner",
  );
  expect(
    await importRenderTranscriptAsset(db, transcriptInput(), "owner"),
  ).toEqual(asset);
  const other = await importRenderTranscriptAsset(
    db,
    transcriptInput("Machine speech words", "other-owner-import"),
    "other",
  );
  expect(other.assetHash).toBe(asset.assetHash);
  expect(other.id).not.toBe(asset.id);
  expect(await getRenderTranscriptAsset(db, other.id, "owner")).toBeNull();
  expect(
    sqlite.prepare("SELECT count(*) n FROM render_transcript_assets").get()?.n,
  ).toBe(2);
});
