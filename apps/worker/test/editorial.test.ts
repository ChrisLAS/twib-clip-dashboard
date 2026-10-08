import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import {
  getEditorialContext,
  getEditorialProfile,
  mutateEditorial,
  recordEditorialReceipt,
  editorialFeedbackSchema,
  editorialProfileSchema,
  editorialReceiptSchema,
} from "../src/editorial";
let sqlite: DatabaseSync;
let db: D1Database;
let loseInsertResponse = false;
class Statement {
  values: (string | number | null)[] = [];
  constructor(private sql: string) {}
  bind(...values: (string | number | null)[]) {
    this.values = values;
    return this;
  }
  async first<T>() {
    return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null;
  }
  async all<T>() {
    return { results: sqlite.prepare(this.sql).all(...this.values) as T[] };
  }
  async run() {
    const result = sqlite.prepare(this.sql).run(...this.values);
    if (
      loseInsertResponse &&
      this.sql.startsWith("INSERT INTO editorial_events")
    ) {
      loseInsertResponse = false;
      throw new Error("Lost response after commit");
    }
    return result;
  }
}
beforeEach(() => {
  loseInsertResponse = false;
  sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).sort())
    sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
  db = {
    prepare: (sql: string) => new Statement(sql),
  } as unknown as D1Database;
  sqlite.prepare("INSERT INTO episodes VALUES(?,?)").run("ep1", "{}");
  sqlite
    .prepare("INSERT INTO clips(id,episode_id,data) VALUES(?,?,?)")
    .run("clip1", "ep1", "{}");
  sqlite
    .prepare("INSERT INTO renders(id,clip_id,data) VALUES(?,?,?)")
    .run("render1", "clip1", "{}");
});
afterEach(() => sqlite.close());
const base = {
  expectedRevision: 0,
  idempotencyKey: "editorial-key1",
  reason: "Explicit preference",
  scope: "global" as const,
};
describe("editorial context", () => {
  it("starts without invented private preferences or load claims", async () => {
    const c = await getEditorialContext(db, "owner");
    expect(c.rules).toEqual([]);
    expect(c.loadedStatus).toBe("no_receipt");
    expect(c.changedBecauseFeedback).toBe(false);
  });
  it("blank approvals remain evidence and do not create rules", async () => {
    await mutateEditorial(db, "owner", "feedback", {
      ...base,
      action: "record",
      decision: "up",
      reason: "",
    });
    expect((await getEditorialProfile(db, "owner")).rules).toEqual([]);
    expect(
      editorialFeedbackSchema.safeParse({
        ...base,
        action: "propose",
        decision: "up",
        reason: " ",
        ruleText: "Invented",
      }).success,
    ).toBe(false);
  });
  it("proposals require confirmation and receipts validate actual cited use", async () => {
    const p = await mutateEditorial(db, "owner", "feedback", {
      ...base,
      action: "propose",
      decision: "down",
      ruleText: "Avoid long intros",
    });
    expect(p.rules).toHaveLength(0);
    const confirmed = await mutateEditorial(db, "owner", "feedback", {
      ...base,
      expectedRevision: 1,
      idempotencyKey: "editorial-key2",
      action: "confirm",
      decision: "down",
      proposalId: p.proposals[0].id,
    });
    expect(confirmed.rules).toHaveLength(1);
    const c = await getEditorialContext(db, "owner", "ep1");
    const input = {
      idempotencyKey: "receipt-key1",
      contextHash: c.contextHash,
      profileVersion: c.profileVersion,
      episodeId: "ep1",
      stage: "selection",
      usedRuleIds: c.rules.map((r) => r.id),
      changedBecauseFeedback: true,
      evidenceIds: c.evidenceIds,
      explanation: "Selected a shorter intro using the confirmed rule.",
    };
    const r = await recordEditorialReceipt(db, "owner", input);
    expect(r.attestation).toBe("caller_reported");
    expect(await recordEditorialReceipt(db, "owner", input)).toEqual(r);
    expect((await getEditorialContext(db, "owner", "ep1")).loadedStatus).toBe(
      "reported_loaded",
    );
    await expect(
      recordEditorialReceipt(db, "owner", {
        ...input,
        idempotencyKey: "receipt-key2",
        usedRuleIds: [],
      }),
    ).rejects.toThrow();
    await expect(recordEditorialReceipt(db, "other", input)).rejects.toThrow();
  });
  it("disable and undo create new revisions while retaining evidence", async () => {
    const p = await mutateEditorial(db, "owner", "feedback", {
      ...base,
      action: "record",
      decision: "up",
    });
    await mutateEditorial(db, "owner", "profile", {
      ...base,
      expectedRevision: p.version,
      idempotencyKey: "editorial-key2",
      action: "disable",
    });
    const restored = await mutateEditorial(db, "owner", "profile", {
      ...base,
      expectedRevision: 2,
      idempotencyKey: "editorial-key3",
      action: "undo",
      undoVersion: 0,
    });
    expect(restored.version).toBe(3);
    expect(restored.enabled).toBe(true);
    expect(restored.feedback).toHaveLength(1);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM editorial_events").get()?.n,
    ).toBe(3);
    expect(() => sqlite.exec("DELETE FROM editorial_events")).toThrow(
      "immutable",
    );
  });
  it("enforces exact render ownership, revision conflicts and idempotency", async () => {
    const input = { ...base, action: "record", decision: "up" };
    const p = await mutateEditorial(db, "owner", "feedback", input);
    expect(await mutateEditorial(db, "owner", "feedback", input)).toEqual(p);
    await expect(
      mutateEditorial(db, "owner", "feedback", { ...input, reason: "Changed" }),
    ).rejects.toThrow("operation key");
    await expect(
      mutateEditorial(db, "owner", "feedback", {
        ...input,
        idempotencyKey: "another-key1",
      }),
    ).rejects.toThrow("Reload");
    await expect(
      mutateEditorial(db, "owner", "feedback", {
        ...input,
        idempotencyKey: "another-key2",
        expectedRevision: 1,
        scope: "render",
        episodeId: "ep1",
        renderId: "missing",
      }),
    ).rejects.toThrow("render");
  });
  it("projects deterministic scoped rules and rejects phantom evidence", async () => {
    const rules = [
      {
        id: "z",
        text: "global",
        scope: "global",
        episodeId: null,
        renderId: null,
        evidenceIds: [],
      },
      {
        id: "a",
        text: "exact",
        scope: "render",
        episodeId: "ep1",
        renderId: "render1",
        evidenceIds: [],
      },
    ];
    await mutateEditorial(db, "owner", "profile", {
      ...base,
      action: "replace",
      rules,
    });
    expect(
      (await getEditorialContext(db, "owner", "ep1")).rules.map((r) => r.id),
    ).toEqual(["z"]);
    expect(
      (await getEditorialContext(db, "owner", "ep1", "render1")).rules.map(
        (r) => r.id,
      ),
    ).toEqual(["a", "z"]);
    await expect(
      mutateEditorial(db, "owner", "profile", {
        ...base,
        action: "replace",
        expectedRevision: 1,
        idempotencyKey: "editorial-key2",
        rules: [{ ...rules[0], evidenceIds: ["made-up"] }],
      }),
    ).rejects.toThrow("explicit feedback");
  });
});

describe("editorial adversarial regression", () => {
  it("isolates the same idempotency key across owners", async () => {
    const first = await mutateEditorial(db, "owner", "feedback", {
      ...base,
      action: "record",
      decision: "up",
    });
    const second = await mutateEditorial(db, "other", "feedback", {
      ...base,
      action: "record",
      decision: "down",
    });
    expect(first.feedback[0].decision).toBe("up");
    expect(second.feedback[0].decision).toBe("down");
    expect((await getEditorialProfile(db, "owner")).feedback).toHaveLength(1);
  });
  it("rejects unknown input fields and oversized rule text", () => {
    expect(
      editorialFeedbackSchema.safeParse({
        ...base,
        action: "record",
        decision: "up",
        surprise: true,
      }).success,
    ).toBe(false);
    expect(
      editorialFeedbackSchema.safeParse({
        ...base,
        action: "propose",
        decision: "up",
        ruleText: "x".repeat(2001),
      }).success,
    ).toBe(false);
  });
  it("requires a reason for direct profile changes", () => {
    expect(
      editorialProfileSchema.safeParse({
        ...base,
        reason: "  ",
        action: "disable",
      }).success,
    ).toBe(false);
  });
  it("validates scope targets and proposal action parameters", () => {
    for (const input of [
      { scope: "render", episodeId: "ep1" },
      { scope: "episode", episodeId: "ep1", renderId: "render1" },
      { scope: "global", episodeId: "ep1" },
    ])
      expect(
        editorialFeedbackSchema.safeParse({
          ...base,
          action: "record",
          decision: "up",
          ...input,
        }).success,
      ).toBe(false);
    expect(
      editorialFeedbackSchema.safeParse({
        ...base,
        action: "confirm",
        decision: "up",
      }).success,
    ).toBe(false);
  });
  it("does not project dismissed proposals", async () => {
    const p = await mutateEditorial(db, "owner", "feedback", {
      ...base,
      action: "propose",
      decision: "up",
      ruleText: "Prefer context",
    });
    await mutateEditorial(db, "owner", "feedback", {
      ...base,
      expectedRevision: 1,
      idempotencyKey: "dismiss-key1",
      action: "dismiss",
      decision: "up",
      proposalId: p.proposals[0].id,
    });
    expect((await getEditorialContext(db, "owner")).rules).toHaveLength(0);
    await expect(
      mutateEditorial(db, "owner", "feedback", {
        ...base,
        expectedRevision: 2,
        idempotencyKey: "confirm-key1",
        action: "confirm",
        decision: "up",
        proposalId: p.proposals[0].id,
      }),
    ).rejects.toThrow("no longer pending");
  });
  it("refuses confirmation that changes a proposal scope", async () => {
    const p = await mutateEditorial(db, "owner", "feedback", {
      ...base,
      scope: "episode",
      episodeId: "ep1",
      action: "propose",
      decision: "up",
      ruleText: "Prefer context",
    });
    await expect(
      mutateEditorial(db, "owner", "feedback", {
        ...base,
        expectedRevision: 1,
        idempotencyKey: "confirm-key1",
        action: "confirm",
        decision: "up",
        proposalId: p.proposals[0].id,
      }),
    ).rejects.toThrow("original proposal scope");
    expect((await getEditorialProfile(db, "owner")).version).toBe(1);
  });
  it("disabled context cannot claim feedback-driven changes", async () => {
    await mutateEditorial(db, "owner", "profile", {
      ...base,
      action: "disable",
    });
    const c = await getEditorialContext(db, "owner", "ep1");
    expect(c.rules).toEqual([]);
    await expect(
      recordEditorialReceipt(db, "owner", {
        idempotencyKey: "receipt-disabled",
        contextHash: c.contextHash,
        profileVersion: 1,
        episodeId: "ep1",
        stage: "research",
        usedRuleIds: [],
        changedBecauseFeedback: true,
        evidenceIds: [],
        explanation: "Unsupported",
      }),
    ).rejects.toThrow("requires used rules");
  });
  it("old receipts do not mark a new profile loaded", async () => {
    const c = await getEditorialContext(db, "owner", "ep1");
    await recordEditorialReceipt(db, "owner", {
      idempotencyKey: "receipt-original",
      contextHash: c.contextHash,
      profileVersion: 0,
      episodeId: "ep1",
      stage: "research",
      usedRuleIds: [],
      changedBecauseFeedback: false,
      evidenceIds: [],
      explanation: "Loaded empty guidance",
      actor: "assistant",
    });
    await mutateEditorial(db, "owner", "profile", {
      ...base,
      action: "disable",
    });
    expect(
      (await getEditorialContext(db, "owner", "ep1")).lastReceipt,
    ).toBeNull();
  });
  it("receipt schema bounds arrays and explanations", () => {
    const input = {
      idempotencyKey: "receipt-bounds",
      contextHash: "a".repeat(64),
      profileVersion: 0,
      episodeId: null,
      stage: "research",
      usedRuleIds: [],
      changedBecauseFeedback: false,
      evidenceIds: [],
      explanation: "Loaded",
    };
    expect(
      editorialReceiptSchema.safeParse({
        ...input,
        usedRuleIds: Array(101).fill("rule"),
      }).success,
    ).toBe(false);
    expect(
      editorialReceiptSchema.safeParse({ ...input, explanation: " " }).success,
    ).toBe(false);
    expect(
      editorialReceiptSchema.safeParse({ ...input, actor: "producer-root" })
        .success,
    ).toBe(false);
  });
  it("does not permit a blank-note review to be cited as a rule", async () => {
    const p = await mutateEditorial(db, "owner", "feedback", {
      ...base,
      action: "record",
      decision: "down",
      reason: "",
    });
    await expect(
      mutateEditorial(db, "owner", "profile", {
        ...base,
        expectedRevision: 1,
        idempotencyKey: "rule-add-key1",
        action: "replace",
        rules: [
          {
            id: "rule",
            text: "Inferred taste",
            scope: "global",
            episodeId: null,
            renderId: null,
            evidenceIds: [p.feedback[0].id],
          },
        ],
      }),
    ).rejects.toThrow("explicit feedback");
  });
  it("existing blank review notes remain exact-render examples only", async () => {
    sqlite
      .prepare("INSERT INTO review_events VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        "review1",
        "review-op1",
        "render1",
        0,
        "up",
        "",
        "",
        "owner",
        "2026-10-08T00:00:00Z",
        "review-fingerprint",
      );
    const c = await getEditorialContext(db, "owner", "ep1", "render1");
    expect(c.reviewExamples[0].renderId).toBe("render1");
    expect(c.coverage.blankReasonCount).toBe(1);
    expect(c.rules).toEqual([]);
    expect(
      (await getEditorialContext(db, "other", "ep1")).reviewExamples,
    ).toEqual([]);
  });
});

it("reconciles a lost insert response without duplicating an event", async () => {
  loseInsertResponse = true;
  const input = { ...base, action: "record", decision: "up" };
  const first = await mutateEditorial(db, "owner", "feedback", input);
  expect(await mutateEditorial(db, "owner", "feedback", input)).toEqual(first);
  expect(
    sqlite.prepare("SELECT count(*) AS n FROM editorial_events").get()?.n,
  ).toBe(1);
});
it("serializes concurrent stale projections atomically", async () => {
  const result = await Promise.allSettled([
    mutateEditorial(db, "owner", "feedback", {
      ...base,
      action: "record",
      decision: "up",
    }),
    mutateEditorial(db, "owner", "feedback", {
      ...base,
      idempotencyKey: "competing-key1",
      action: "record",
      decision: "down",
    }),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect((await getEditorialProfile(db, "owner")).version).toBe(1);
});
it("carries historical exact-render examples into new episodes without reviving cleared votes", async () => {
  sqlite
    .prepare(
      "INSERT INTO episode_workspaces(id,data,status) VALUES(?,?,'draft')",
    )
    .run("next-episode", JSON.stringify({ id: "next-episode", number: 2 }));
  sqlite
    .prepare("INSERT INTO review_events VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(
      "review-a",
      "review-a-key",
      "render1",
      0,
      "up",
      "",
      "",
      "owner",
      "2026-10-08T00:00:00Z",
      "fp-a",
    );
  let c = await getEditorialContext(db, "owner", "next-episode");
  expect(c.reviewExamples).toHaveLength(1);
  expect(c.reviewExamples[0].episodeId).toBe("ep1");
  expect(c.reviewExamples[0].isCurrentEpisode).toBe(false);
  sqlite
    .prepare("INSERT INTO review_events VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(
      "review-b",
      "review-b-key",
      "render1",
      1,
      "down",
      "",
      "",
      "owner",
      "2026-10-08T00:00:01Z",
      "fp-b",
    );
  c = await getEditorialContext(db, "owner", "next-episode");
  expect(c.reviewExamples).toHaveLength(1);
  expect(c.reviewExamples[0].decision).toBe("down");
  sqlite
    .prepare("INSERT INTO review_events VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(
      "review-c",
      "review-c-key",
      "render1",
      2,
      "clear",
      "",
      "",
      "owner",
      "2026-10-08T00:00:02Z",
      "fp-c",
    );
  expect(
    (await getEditorialContext(db, "owner", "next-episode")).reviewExamples,
  ).toEqual([]);
});

it("rejects phantom or mismatched context targets and receipts", async () => {
  await expect(getEditorialContext(db, "owner", "missing")).rejects.toThrow(
    "Episode not found",
  );
  await expect(
    getEditorialContext(db, "owner", "ep1", "missing"),
  ).rejects.toThrow("render");
  await expect(
    getEditorialContext(db, "owner", null, "render1"),
  ).rejects.toThrow("valid episode");
  sqlite.prepare("INSERT INTO episodes VALUES(?,?)").run("ep2", "{}");
  await expect(
    getEditorialContext(db, "owner", "ep2", "render1"),
  ).rejects.toThrow("render");
  await expect(
    recordEditorialReceipt(db, "owner", {
      idempotencyKey: "phantom-receipt",
      contextHash: "a".repeat(64),
      profileVersion: 0,
      episodeId: "missing",
      stage: "selection",
      usedRuleIds: [],
      changedBecauseFeedback: false,
      evidenceIds: [],
      explanation: "Phantom target",
    }),
  ).rejects.toThrow("Episode not found");
});

it("canonical context is independent of JSON object key order", async () => {
  const profile = await mutateEditorial(db, "owner", "profile", {
    ...base,
    action: "replace",
    rules: [
      {
        id: "canonical-rule",
        text: "An explicit rule",
        scope: "global",
        episodeId: null,
        renderId: null,
        evidenceIds: [],
      },
    ],
  });
  const before = await getEditorialContext(db, "owner", "ep1");
  const r = profile.rules[0];
  const reversed = {
    evidenceIds: r.evidenceIds,
    renderId: r.renderId,
    episodeId: r.episodeId,
    scope: r.scope,
    text: r.text,
    id: r.id,
  };
  sqlite
    .prepare("UPDATE editorial_profiles SET data=? WHERE owner=?")
    .run(JSON.stringify({ ...profile, rules: [reversed] }), "owner");
  const after = await getEditorialContext(db, "owner", "ep1");
  expect(after.contextHash).toBe(before.contextHash);
});
