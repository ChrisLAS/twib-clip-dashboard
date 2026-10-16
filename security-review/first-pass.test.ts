import { describe, expect, it } from "vitest";
import { cutSpecSchema } from "../apps/worker/src/capture-jobs/cut-contract";
import { cutView, preparedCut } from "../apps/worker/src/capture-jobs/cut";
import type { InventoryItem } from "../apps/worker/src/inventory/contract";
const item: InventoryItem = {
  id: "item_" + "a".repeat(64),
  kind: "media",
  media: {
    ref: "original.mp4",
    present: true,
    size_bytes: 123,
    duration_seconds: 600,
    modified_at: null,
  },
  observations: [],
  origins: [],
  processing_status: "unverified",
  ready: false,
};
describe("first-pass requests", () => {
  it("accepts optional guidance without manufacturing an executable range", () => {
    for (const spec of [
      { kind: "first_pass" },
      { kind: "first_pass", guidance: "Keep the payoff", startSeconds: 20 },
    ]) {
      const p = preparedCut(
        {
          episodeNumber: 127,
          operationId: "12345678-1234-4234-8234-123456789abc",
          expectedVersion: "v1",
          expectedRevision: 1,
          cutSpec: spec,
        },
        item,
        "owner",
        1,
      )!;
      expect(p.state).toBe("needs_review");
      const view = cutView({
        request_id: p.id,
        item_id: p.itemId,
        owner: p.owner,
        parent_version: p.version,
        review_revision: p.revision,
        request_json: p.wire,
        state: p.state,
        derivative_json: null,
        code: null,
      });
      expect(view.code).toBe("CONTEXT_MISSING");
      expect(view.contextRevision).toBeNull();
      expect(view.derivative).toBeNull();
    }
  });
  it("rejects client revisions, invented endpoints and invalid hints", () => {
    for (const extra of [
      { contextRevision: "fake" },
      { endSeconds: 60 },
      { guidance: " " },
      { guidance: "x".repeat(2001) },
      { startSeconds: -1 },
    ]) {
      expect(
        cutSpecSchema.safeParse({ kind: "first_pass", ...extra }).success,
      ).toBe(false);
    }
  });
});
