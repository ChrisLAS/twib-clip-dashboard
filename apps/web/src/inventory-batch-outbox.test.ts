import { describe, it, expect } from "vitest";
import {
  clearOutbox,
  newOutbox,
  outboxKey,
  readOutbox,
  scopedDraftIds,
  writeOutbox,
} from "./inventory-batch-outbox";
import type { InventoryReviewInput } from "@twib/shared";
const scope = {
  episodeNumber: 127,
  owner: "owner-a",
  source: "source",
  episode: "episode",
};
const payload: InventoryReviewInput = {
  operationId: "00000000-0000-4000-8000-000000000001",
  episodeNumber: 127,
  itemId: "item_" + "a".repeat(64),
  expectedRevision: 0,
  expectedVersion: "b".repeat(64),
  action: "decision",
  status: "cut_down",
  notes: "private note",
  reason: "first pass",
  cutSpec: { kind: "first_pass" },
};
function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  } as Storage;
}
describe("durable batch outbox", () => {
  it("round-trips exact immutable operations and retains all unsent items before dispatch", () => {
    const s = storage();
    const box = newOutbox(scope, [
      payload,
      {
        ...payload,
        itemId: "item_" + "c".repeat(64),
        operationId: "00000000-0000-4000-8000-000000000002",
      },
    ]);
    writeOutbox(s, scope, box);
    expect(readOutbox(s, scope)?.entries.map((e) => e.payload)).toEqual(
      box.entries.map((e) => e.payload),
    );
    expect(
      readOutbox(s, scope)?.entries.every((e) => e.status === "pending"),
    ).toBe(true);
    expect(s.getItem(outboxKey(scope))).not.toContain("csrf");
    expect(box.entries[0].attempted).toBe(false);
    box.entries[0].attempted = true;
    writeOutbox(s, scope, box);
    const unattempted = structuredClone(box);
    unattempted.entries[0].attempted = false;
    expect(() => writeOutbox(s, scope, unattempted)).toThrow("immutable");
    const altered = structuredClone(box);
    altered.entries[0].payload.operationId =
      "00000000-0000-4000-8000-000000000099";
    expect(() => writeOutbox(s, scope, altered)).toThrow("immutable");
    expect(() => clearOutbox(s, scope)).toThrow("Reconcile");
    box.entries[0].status = "saved";
    box.entries[1].status = "rejected";
    writeOutbox(s, scope, box);
    const reverted = structuredClone(box);
    reverted.entries[0].status = "pending";
    expect(() => writeOutbox(s, scope, reverted)).toThrow("immutable");
    clearOutbox(s, scope);
    expect(readOutbox(s, scope)).toBeNull();
  });
  it("fails closed on corrupt, unavailable, wrong-owner, invalid payload and unexpected fields", () => {
    const s = storage();
    for (const raw of [
      "bad JSON",
      JSON.stringify({ ...newOutbox(scope, [payload]), owner: "owner-b" }),
      JSON.stringify({ ...newOutbox(scope, [payload]), csrfToken: "never" }),
    ]) {
      s.setItem(outboxKey(scope), raw);
      expect(() => readOutbox(s, scope)).toThrow();
    }
    expect(() =>
      readOutbox(
        {
          getItem: () => {
            throw new Error("denied");
          },
        } as unknown as Storage,
        scope,
      ),
    ).toThrow();
    expect(() =>
      writeOutbox(
        {
          setItem: () => {
            throw new Error("quota");
          },
        } as unknown as Storage,
        scope,
        newOutbox(scope, [payload]),
      ),
    ).toThrow();
    expect(() =>
      writeOutbox(
        { setItem: () => {}, getItem: () => null } as unknown as Storage,
        scope,
        newOutbox(scope, [payload]),
      ),
    ).toThrow("verified");
    expect(() =>
      newOutbox(scope, [{ ...payload, operationId: "invalid" }]),
    ).toThrow();
    expect(() => newOutbox(scope, [payload, payload])).toThrow();
    expect(readOutbox(storage(), { ...scope, owner: "owner-b" })).toBeNull();
  });
  it("preserves pending uncertainty after a server commit whose response cannot be persisted", () => {
    const s = storage(),
      box = newOutbox(scope, [payload]);
    writeOutbox(s, scope, box);
    const before = readOutbox(s, scope)!;
    box.entries[0].status = "saved";
    expect(() =>
      writeOutbox(
        {
          ...s,
          setItem: () => {
            throw new Error("quota");
          },
        } as Storage,
        scope,
        box,
      ),
    ).toThrow();
    expect(readOutbox(s, scope)).toEqual(before);
    expect(readOutbox(s, scope)?.entries[0].payload.operationId).toBe(
      payload.operationId,
    );
  });
  it("finds all unsaved drafts in the source/episode regardless of visible page", () => {
    const drafts = {
      [JSON.stringify(["source", "episode", "clip-on-other-page"])]: {},
      [JSON.stringify(["source", "other", "ignore"])]: {},
      broken: {},
    };
    expect(scopedDraftIds(drafts, "source", "episode")).toEqual([
      "clip-on-other-page",
    ]);
  });
});

it("preserves historical 127 outboxes and rejects mismatched 128 payload scope", () => {
  const s = storage();
  const historical = newOutbox(scope, [payload]);
  writeOutbox(s, scope, historical);
  expect(JSON.parse(s.getItem(outboxKey(scope))!)).not.toHaveProperty(
    "episodeNumber",
  );
  const next = { ...scope, episode: "episode128", episodeNumber: 128 };
  const nextPayload = { ...payload, episodeNumber: 128 };
  expect(readOutbox(s, next)).toBeNull();
  expect(() => newOutbox(next, [payload])).toThrow("another episode");
  const box = newOutbox(next, [nextPayload]);
  writeOutbox(s, next, box);
  expect(readOutbox(s, scope)).toEqual(historical);
  expect(readOutbox(s, next)?.entries[0].payload).toEqual(nextPayload);
  const corrupt = { ...box, entries: historical.entries };
  expect(() => writeOutbox(s, next, corrupt)).toThrow("scope");
  s.setItem(outboxKey(next), JSON.stringify(corrupt));
  expect(() => readOutbox(s, next)).toThrow("scope");
  expect(readOutbox(s, scope)?.entries[0].payload.operationId).toBe(
    payload.operationId,
  );
});
