import { it, expect } from "vitest";
import type { InventoryCutRequest } from "@twib/shared";
import { cutStatusLabel } from "./inventory-cut-status";
const base = {
  spec: { kind: "first_pass" },
  state: "queued",
  code: null,
  derivative: null,
  proposal: null,
} as InventoryCutRequest;
it("distinguishes first-pass planning from rendering and a real derivative", () => {
  expect(cutStatusLabel({ ...base, transitionCode: "PLAN_CONFLICT" })).toMatch(
    /Automatic cut blocked/,
  );
  expect(cutStatusLabel(base)).toBe("Queued for episode-context planning");
  expect(cutStatusLabel({ ...base, state: "running" })).toBe(
    "Planning cutdown",
  );
  expect(
    cutStatusLabel({
      ...base,
      state: "queued",
      spec: { kind: "range", startSeconds: 1, endSeconds: 20 },
    }),
  ).toBe("Queued for cutdown render");
  expect(
    cutStatusLabel({
      ...base,
      state: "running",
      spec: { kind: "range", startSeconds: 1, endSeconds: 20 },
    }),
  ).toBe("Rendering review version");
  expect(
    cutStatusLabel({ ...base, state: "needs_review", code: "CONTEXT_MISSING" }),
  ).toMatch(/Blocked/);
  expect(cutStatusLabel({ ...base, state: "failed" })).toMatch(/failed/);
  expect(cutStatusLabel({ ...base, state: "succeeded" })).toMatch(
    /not attached/,
  );
  expect(
    cutStatusLabel({
      ...base,
      proposal: {} as NonNullable<InventoryCutRequest["proposal"]>,
    }),
  ).toMatch(/plan prepared/);
  expect(
    cutStatusLabel({
      ...base,
      state: "failed",
      derivative: {} as NonNullable<InventoryCutRequest["derivative"]>,
    }),
  ).toBe("Review version available · Unreviewed");
});
