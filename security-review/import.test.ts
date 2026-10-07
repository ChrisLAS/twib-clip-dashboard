import { describe, expect, it, vi } from "vitest";
import { importManifest, manifestSchema } from "../apps/worker/src/importer";
import type { Env } from "../apps/worker/src/env";
const empty = {
  schemaVersion: 1 as const,
  episodes: [],
  clips: [],
  renders: [],
  artifacts: [],
  events: [],
  activations: [],
};
const db = {
  prepare: () => ({ bind: () => ({ first: async () => null }) }),
  batch: vi.fn(),
};
const env = { DB: db, ALLOWED_EPISODE_IDS: "ep-demo" } as unknown as Env;
describe("Producer validation fixtures", () => {
  it("rejects request-controlled Drive URLs as file IDs", () => {
    expect(
      manifestSchema.safeParse({
        ...empty,
        artifacts: [
          {
            renderId: "r1",
            kind: "original",
            fileId: "https://evil.example",
            size: 1,
            sha256: "a".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects unknown schema and producer-owned review injection", () => {
    expect(
      manifestSchema.safeParse({ ...empty, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      manifestSchema.safeParse({ ...empty, reviews: [{ decision: "up" }] })
        .success,
    ).toBe(false);
  });
  it("rejects duplicate keys before writes", async () => {
    const e = {
      id: "ep-demo",
      number: 1,
      title: "a",
      subtitle: "",
      clipCount: 0,
      publishedGuid: null,
    };
    await expect(
      importManifest(
        env,
        { ...empty, episodes: [e, { ...e, title: "changed" }] },
        "fixture",
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_MANIFEST_KEY" });
    expect(db.batch).not.toHaveBeenCalled();
  });
  it("rejects unknown current-render pointers", async () => {
    await expect(
      importManifest(
        env,
        {
          ...empty,
          clips: [
            {
              id: "c1",
              episodeId: "ep-demo",
              title: "",
              summary: "",
              narrativeRole: "",
              currentRenderId: "r1",
              renderIds: ["r1"],
            },
          ],
        },
        "fixture",
      ),
    ).rejects.toMatchObject({ code: "INVALID_RENDER_REFERENCE" });
  });
  it("rejects cross-clip attempt IDs", async () => {
    const event = {
      schemaVersion: 1 as const,
      id: "e1",
      attemptId: "a1",
      clipId: "c1",
      sequence: 1,
      occurredAt: "2026-10-07T10:00:00Z",
      stage: "working",
      state: "working" as const,
      progress: true,
      nextExpectedAt: null,
      blocker: null,
      checkpoint: null,
    };
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () =>
            sql.includes("SELECT episode_id")
              ? { episode_id: "ep-demo" }
              : sql.includes("SELECT clip_id FROM producer_events")
                ? { clip_id: "other-clip" }
                : null,
        }),
      }),
      batch: vi.fn(),
    };
    await expect(
      importManifest(
        { ...env, DB: db } as unknown as Env,
        { ...empty, events: [event] },
        "fixture",
      ),
    ).rejects.toMatchObject({ code: "ATTEMPT_OWNERSHIP" });
    expect(db.batch).not.toHaveBeenCalled();
  });
});

describe("Immutable manifest replay", () => {
  it("skips an already committed manifest before validating older render pointers", async () => {
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({
        first: async () =>
          sql.includes("imported_manifests")
            ? { hash: "already-committed" }
            : null,
      }),
    }));
    const batch = vi.fn();
    const fetcher = vi.fn();
    await importManifest(
      { ...env, DB: { prepare, batch } } as unknown as Env,
      {
        ...empty,
        clips: [
          {
            id: "c1",
            episodeId: "ep-demo",
            title: "old",
            summary: "",
            narrativeRole: "",
            currentRenderId: "old-v1",
            renderIds: ["old-v1"],
          },
        ],
      },
      "fixture",
      fetcher,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(batch).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
