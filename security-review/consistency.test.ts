import { describe, expect, it } from "vitest";
import { mutate, projectProduction } from "../apps/worker/src/store";
import type { ProducerEvent } from "@twib/shared";
describe("Independent consistency fixtures", () => {
  it("does not acknowledge different content after zero-row racing insert", async () => {
    let operationReads = 0;
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () =>
            sql.includes("FROM operations")
              ? ++operationReads === 1
                ? null
                : {
                    fingerprint: "different-request",
                    response: JSON.stringify({ decision: "down", revision: 1 }),
                  }
              : { revision: 1 },
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
    } as unknown as D1Database;
    await expect(
      mutate(
        db,
        "review",
        "r1",
        { decision: "up", expectedRevision: 0, idempotencyKey: "collision" },
        "owner",
      ),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_REUSE" });
  });
  it("late old-attempt events never replace active state or progress", () => {
    const base = {
      schemaVersion: 1,
      clipId: "c1",
      occurredAt: "2026-10-07T10:00:00Z",
      stage: "Rendering",
      state: "working",
      progress: true,
      nextExpectedAt: "2026-10-07T10:05:00Z",
      blocker: null,
      checkpoint: null,
    } as const;
    const items: ProducerEvent[] = [
      { ...base, id: "new", attemptId: "new", sequence: 1 },
      {
        ...base,
        id: "old",
        attemptId: "old",
        sequence: 99,
        state: "failed",
        occurredAt: "2026-10-07T11:00:00Z",
      },
    ];
    const p = projectProduction(
      items,
      "new",
      Date.parse("2026-10-07T11:00:00Z"),
    );
    expect(p.state).toBe("working");
    expect(p.lastProgressAt).toBe(base.occurredAt);
    expect(p.stale).toBe(true);
    expect(
      projectProduction(items, "new", Date.parse("2026-10-07T12:00:00Z"))
        .lastProgressAt,
    ).toBe(p.lastProgressAt);
  });
});

import { getEpisode } from "../apps/worker/src/store";
describe("Readiness projection", () => {
  function fixture({
    media = true,
    hash = "a".repeat(64),
    qaHash = hash,
    mapping = true,
  }: {
    media?: boolean;
    hash?: string | null;
    qaHash?: string | null;
    mapping?: boolean;
  } = {}) {
    const render = {
      id: "r1",
      clipId: "c1",
      mappingVerified: mapping,
      artifactHash: hash,
      qa: ["artifact", "container", "codecs", "duration", "mapping"].map(
        (check) => ({ check, result: "passed", artifactHash: qaHash }),
      ),
    };
    const event = {
      id: "e1",
      attemptId: "a1",
      clipId: "c1",
      sequence: 1,
      occurredAt: "2026-10-07T10:00:00Z",
      state: "ready",
      stage: "Ready",
      progress: true,
      nextExpectedAt: null,
      blocker: null,
      checkpoint: null,
    };
    const db = {
      prepare: (sql: string) => ({
        first: async () => null,
        bind: () => ({
          first: async () =>
            sql.includes("FROM episodes")
              ? { data: JSON.stringify({ id: "ep-demo" }) }
              : sql.includes("FROM renders")
                ? {
                    data: JSON.stringify(render),
                    revision: 0,
                    decision: "clear",
                    note: "",
                    reason: "",
                    updated_at: null,
                  }
                : sql.includes("FROM artifacts")
                  ? media
                    ? {
                        file_id: "approved",
                        render_id: "r1",
                        sha256: "a".repeat(64),
                      }
                    : null
                  : null,
          all: async () => ({
            results: sql.includes("FROM clips")
              ? [
                  {
                    data: JSON.stringify({ id: "c1", currentRenderId: "r1" }),
                    active_attempt_id: "a1",
                    revision: 0,
                    visibility: "visible",
                  },
                ]
              : [{ data: JSON.stringify(event) }],
          }),
        }),
      }),
    } as unknown as D1Database;
    return getEpisode(db, "ep-demo");
  }
  it("permits ready only with matching immutable evidence", async () =>
    expect((await fixture()).clips[0].production.state).toBe("ready"));
  it.each([
    { media: false },
    { mapping: false },
    { qaHash: "different" },
    { hash: null, qaHash: null },
  ])("does not claim ready for incomplete evidence %o", async (options) =>
    expect((await fixture(options)).clips[0].production.state).not.toBe(
      "ready",
    ),
  );
});
