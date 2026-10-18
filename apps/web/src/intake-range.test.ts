import { describe, expect, it, vi, afterEach } from "vitest";
import {
  parseRange,
  parseRangeDraft,
  rangeBindingKey,
  rangeDraftKey,
  validRangeInput,
  validRangeReceipt,
  rangeAttemptConfirmed,
} from "./intake-range";
import {
  parseWorkAttempt,
  parseWorkEnvelope,
  workAttemptConfirmed,
} from "./intake-work-panel";
import { api } from "./api";
import type { IntakeRangeInput, IntakeWorkView } from "@twib/shared";
const binding = {
  expectedCutRequestId: "00000000-0000-4000-8000-000000000001",
  expectedRequestRevision: "a".repeat(64),
  expectedParentVersion: "b".repeat(64),
  expectedRevision: 1,
  expectedWorkspaceRevision: 1,
  episodeNumber: 128,
};
const input: IntakeRangeInput = {
  ...binding,
  range: { kind: "range", startSeconds: 10.125, endSeconds: 30.5 },
};
const attempt = {
  kind: "range" as const,
  intakeId: "intake-a",
  jobId: "job-a",
  input,
};
afterEach(() => vi.unstubAllGlobals());
describe("manual range drafts and immutable confirmation", () => {
  it.each([
    ["", ""],
    ["0", "181"],
    ["10", "10"],
    ["-1", "4"],
    ["1e2", "110"],
    ["0.0001", "2"],
    [" 1", "2"],
    ["Infinity", "4"],
  ])("rejects invalid seconds %s,%s", (a, b) =>
    expect(parseRange(a, b)).toBeNull(),
  );
  it("accepts millisecond source seconds and180second boundary", () => {
    expect(parseRange("10.125", "30.5")).toEqual(input.range);
    expect(parseRange("0", "180")).toMatchObject({
      startSeconds: 0,
      endSeconds: 180,
    });
  });
  it("preserves drafts against exact owner and immutable binding across reload", () => {
    const draft = {
      version: 1,
      owner: "owner",
      jobId: "job-a",
      binding,
      start: "10.125",
      end: "30.5",
    };
    expect(parseRangeDraft(JSON.stringify(draft), "owner", "job-a")).toEqual(
      draft,
    );
    expect(() =>
      parseRangeDraft(JSON.stringify(draft), "other", "job-a"),
    ).toThrow();
    expect(() =>
      parseRangeDraft(JSON.stringify(draft), "owner", "job-b"),
    ).toThrow();
    expect(rangeBindingKey(binding)).not.toBe(
      rangeBindingKey({ ...binding, expectedWorkspaceRevision: 2 }),
    );
    expect(rangeDraftKey("owner", "job-a")).not.toBe(
      rangeDraftKey("other", "job-a"),
    );
  });
  it("restores pending range only with valid bindings and exact range", () => {
    expect(validRangeInput(input)).toBe(true);
    expect(parseWorkAttempt(JSON.stringify(attempt))).toEqual(attempt);
    expect(
      parseWorkEnvelope(
        JSON.stringify({
          version: 2,
          owner: "owner",
          scope: "manual-intake-work",
          attempt,
        }),
        "owner",
      ),
    ).toEqual(attempt);
    for (const change of [
      { ...input, episodeNumber: 0 },
      { ...input, expectedParentVersion: "wrong" },
      { ...input, range: { ...input.range, endSeconds: 300 } },
      { ...input, range: { kind: "first_pass" } },
    ])
      expect(
        parseWorkAttempt(JSON.stringify({ ...attempt, input: change })),
      ).toBeNull();
  });
  it("readback clears only the exact child binding and range", () => {
    const job = {
      jobId: "job-a",
      intakeId: "intake-a",
      rangeSelection: binding,
      cutRequest: {
        selectionOrigin: "owner_range",
        sourcePlanRequestId: binding.expectedCutRequestId,
        parentVersion: binding.expectedParentVersion,
        spec: input.range,
      },
    } as IntakeWorkView;
    expect(rangeAttemptConfirmed(input, job)).toBe(true);
    expect(workAttemptConfirmed(attempt, [job])).toBe(true);
    expect(
      rangeAttemptConfirmed(
        { ...input, range: { ...input.range, endSeconds: 31 } },
        job,
      ),
    ).toBe(false);
    expect(
      rangeAttemptConfirmed({ ...input, expectedWorkspaceRevision: 2 }, job),
    ).toBe(false);
    expect(workAttemptConfirmed({ ...attempt, jobId: "other" }, [job])).toBe(
      false,
    );
    expect(
      rangeAttemptConfirmed(input, {
        ...job,
        cutRequest: { ...job.cutRequest!, selectionOrigin: "model_proposal" },
      }),
    ).toBe(false);
  });
  it("posts only explicit source-bound range via owner CSRF route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ requestId: "child" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await api.selectIntakeRange("intake/a", "job/a", input, "csrf");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/intake/intake%2Fa/work/job%2Fa/range",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": "csrf" },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(input);
  });
});

it("requires exact bounded receipt before clearing submitted range intent", () => {
  const receipt = {
    requestId: "00000000-0000-4000-8000-000000000003",
    sourcePlanRequestId: input.expectedCutRequestId,
    selectionOrigin: "owner_range",
  };
  expect(validRangeReceipt(receipt, input)).toBe(true);
  for (const value of [
    null,
    {},
    { ...receipt, requestId: "child" },
    { ...receipt, sourcePlanRequestId: "other" },
    { ...receipt, selectionOrigin: "model_proposal" },
  ])
    expect(validRangeReceipt(value, input)).toBe(false);
});
