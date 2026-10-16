import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntakeWorkView } from "@twib/shared";
import { api } from "./api";
import {
  intakeWorkLabel,
  parseWorkAttempt,
  parseWorkEnvelope,
  workAttemptConfirmed,
} from "./intake-work-panel";
const job: IntakeWorkView = {
  jobId: "work-a",
  intakeId: "intake-a",
  intakeRevision: 2,
  episodeId: "episode-a",
  episodeNumber: 10,
  priority: "normal",
  state: "saved",
  stage: "saved",
  code: null,
  attempt: 1,
  updatedAt: "2026-10-16T00:00:00Z",
  stale: false,
};
afterEach(() => vi.unstubAllGlobals());
describe("intake work recovery", () => {
  it("requires schema, scope, and the exact authenticated owner", () => {
    const payload = {
      version: 2,
      scope: "manual-intake-work",
      owner: "owner-a",
      attempt: {
        kind: "save",
        intakeId: "intake-a",
        expectedRevision: 2,
        priority: "normal",
      },
    };
    expect(parseWorkEnvelope(JSON.stringify(payload), "owner-a")).toEqual(
      payload.attempt,
    );
    for (const changed of [
      { ...payload, owner: "owner-b" },
      { ...payload, version: 1 },
      { ...payload, scope: "other" },
      { ...payload, attempt: {} },
    ])
      expect(() =>
        parseWorkEnvelope(JSON.stringify(changed), "owner-a"),
      ).toThrow();
    expect(() => parseWorkEnvelope("{", "owner-a")).toThrow();
    expect(() => parseWorkEnvelope(JSON.stringify(payload), "")).toThrow();
  });
  it("rejects malformed or incomplete saved attempts", () => {
    for (const value of [
      null,
      "{",
      "null",
      "{}",
      JSON.stringify({
        kind: "save",
        intakeId: "i",
        expectedRevision: -1,
        priority: "normal",
      }),
      JSON.stringify({
        kind: "retry",
        intakeId: "i",
        jobId: "j",
        expectedAttempt: -1,
      }),
    ])
      expect(parseWorkAttempt(value)).toBeNull();
  });
  it("retains exact revision and priority across reload", () => {
    const attempt = {
      kind: "save" as const,
      intakeId: "intake-a",
      expectedRevision: 2,
      priority: "normal" as const,
    };
    expect(parseWorkAttempt(JSON.stringify(attempt))).toEqual(attempt);
    expect(workAttemptConfirmed(attempt, [job])).toBe(true);
    expect(
      workAttemptConfirmed({ ...attempt, expectedRevision: 3 }, [job]),
    ).toBe(false);
    expect(
      workAttemptConfirmed({ ...attempt, priority: "urgent" }, [job]),
    ).toBe(false);
  });
  it("confirms retries only after the exact job advances its attempt", () => {
    const attempt = {
      kind: "retry" as const,
      intakeId: "intake-a",
      jobId: "work-a",
      expectedAttempt: 1,
      expectedTargetId: "work-a",
    };
    expect(workAttemptConfirmed(attempt, [job])).toBe(false);
    expect(workAttemptConfirmed(attempt, [{ ...job, state: "queued" }])).toBe(
      true,
    );
    expect(workAttemptConfirmed(attempt, [{ ...job, state: "running" }])).toBe(
      true,
    );
    expect(
      workAttemptConfirmed(attempt, [{ ...job, state: "needs_review" }]),
    ).toBe(false);
    expect(
      workAttemptConfirmed(attempt, [
        { ...job, state: "queued", retryTargetId: "later-cut" },
      ]),
    ).toBe(false);
    expect(
      workAttemptConfirmed({ ...attempt, expectedTargetId: "later-cut" }, [
        { ...job, state: "queued", retryTargetId: "later-cut" },
      ]),
    ).toBe(true);
    expect(workAttemptConfirmed(attempt, [{ ...job, attempt: 2 }])).toBe(true);
    expect(
      workAttemptConfirmed(attempt, [
        { ...job, jobId: "different", attempt: 2 },
      ]),
    ).toBe(false);
  });
  it("does not claim readiness for unknown states", () => {
    expect(intakeWorkLabel(job)).toBe("Saved");
    expect(intakeWorkLabel({ stage: "new-stage", state: "new-state" })).toBe(
      "Status unavailable",
    );
    expect(
      intakeWorkLabel({ stage: "needs_direction", state: "blocked" }),
    ).toBe("Needs direction");
  });
  it("uses separate explicit save and retry contracts without notes or approval", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => job });
    vi.stubGlobal("fetch", fetchMock);
    await api.saveIntakeWork(
      "intake/a",
      { expectedRevision: 2, priority: "urgent" },
      "csrf",
    );
    expect(fetchMock.mock.calls[0][0]).toBe("/api/intake/intake%2Fa/work");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      expectedRevision: 2,
      priority: "urgent",
    });
    await api.retryIntakeWork(
      "intake/a",
      "job/a",
      { expectedAttempt: 1 },
      "csrf",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/intake/intake%2Fa/work/job%2Fa/retry",
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      expectedAttempt: 1,
    });
  });
});
