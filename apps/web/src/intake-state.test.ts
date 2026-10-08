import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Episode,
  IntakeCreateInput,
  IntakeMutationResult,
  ManualIntake,
} from "@twib/shared";
import { api, RequestError, UncertainIntakeError } from "./api";
import {
  chooseEpisode,
  episodeUrl,
  requestedEpisode,
} from "./episode-selection";
import {
  intakeTime,
  parseIntakeTime,
  pendingIntakes,
  preserveIntakes,
} from "./intake-state";

const episode = (id: string, active = false): Episode => ({
  id,
  number: 1,
  title: id,
  subtitle: "",
  clipCount: 0,
  publishedGuid: null,
  isActive: active,
  status: "draft",
});
const intake: ManualIntake = {
  id: "intake-a",
  episodeId: "draft",
  kind: "already_cut",
  submittedUrl: "https://example.com/video",
  canonicalUrl: "https://example.com/video",
  provider: "other",
  inMs: null,
  outMs: null,
  whyItMatters: "Context",
  status: "awaiting_processing",
  revision: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const body: IntakeCreateInput = {
  episodeId: "draft",
  kind: "already_cut",
  url: intake.submittedUrl,
  expectedRevision: 0,
  idempotencyKey: "exact-retry-key",
};
const result: IntakeMutationResult = { intake, intakeVersion: 1 };
afterEach(() => vi.unstubAllGlobals());

describe("episode selection", () => {
  it("loads an explicitly selected historical episode instead of the first active one", () => {
    const episodes = [
      episode("active", true),
      { ...episode("published"), status: "published" as const },
    ];
    expect(chooseEpisode(episodes, "published")?.id).toBe("published");
    expect(chooseEpisode(episodes, null)?.id).toBe("active");
    expect(chooseEpisode(episodes, "removed")?.id).toBe("active");
    expect(chooseEpisode([], "removed")).toBeNull();
  });
  it("keeps episode selection and unrelated query state across review/back/refresh URLs", () => {
    const href = "https://desk.example.com/?demo=1&episode=older#clip/old";
    const next = episodeUrl(href, "draft-2", "cut-1");
    expect(next).toBe("/?demo=1&episode=draft-2#clip/cut-1");
    expect(episodeUrl(new URL(next, href).href, "draft-2")).toBe(
      "/?demo=1&episode=draft-2",
    );
    expect(requestedEpisode(new URL(next, href).href)).toBe("draft-2");
  });
});

describe("manual-intake state", () => {
  it.each([
    ["", null],
    ["0", 0],
    ["1:30", 90000],
    ["1:02:03.125", 3723125],
    ["60.5", 60500],
  ])("parses source time %s", (input, output) => {
    expect(parseIntakeTime(input as string)).toBe(output);
  });
  it.each([
    "-1",
    "1:60",
    "1:2:99",
    "1::2",
    "abc",
    "0x11",
    "1e3",
    "1.1234",
    "Infinity",
  ])("rejects malformed time %s", (input) => {
    expect(Number.isNaN(parseIntakeTime(input))).toBe(true);
  });
  it.each([0, 999, 60000, 60500, 3723125])(
    "round-trips exact millisecond range %s",
    (value) => {
      expect(parseIntakeTime(intakeTime(value))).toBe(value);
    },
  );
  it("keeps pending, cancelled, unassigned and other-episode counts separate", () => {
    const items = [
      intake,
      { ...intake, id: "cancelled", status: "cancelled" as const },
      { ...intake, id: "later", episodeId: null },
      { ...intake, id: "other", episodeId: "published" },
    ];
    expect(pendingIntakes(items, "draft").map((item) => item.id)).toEqual([
      "intake-a",
    ]);
    expect(pendingIntakes(items, null).map((item) => item.id)).toEqual([
      "later",
    ]);
  });
  it("cannot roll back a confirmed revision or move a newer assignment with stale data", () => {
    const newer = {
      ...intake,
      revision: 3,
      episodeId: "published",
      whyItMatters: "New note",
    };
    expect(preserveIntakes([newer], [intake])).toEqual([newer]);
  });
});

describe("manual-intake API consistency", () => {
  it("only records metadata on same-origin endpoint and does not fetch the supplied source", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.createIntake(body, "csrf")).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/intake",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": "csrf" },
      }),
    );
  });
  it("reconciles an uncertain save against its exact operation receipt", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network interrupted"))
      .mockResolvedValueOnce(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.createIntake(body, "csrf")).resolves.toEqual(result);
    expect(fetcher.mock.calls[1][0]).toBe("/api/operations/exact-retry-key");
  });
  it("reports uncertainty then permits an identical retry with the retained request key", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.createIntake(body, "csrf")).rejects.toBeInstanceOf(
      UncertainIntakeError,
    );
    await expect(api.createIntake(body, "csrf")).resolves.toEqual(result);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[2][1].body);
  });
  it("retains exact duplicate targets and does not reconcile a definitive conflict", async () => {
    const details = {
      error: { code: "DUPLICATE_INTAKE", message: "Already added" },
      duplicateMatches: [
        {
          kind: "intake",
          id: intake.id,
          episodeId: "draft",
          rangeMatch: "exact",
        },
      ],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(details), { status: 409 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const error = await api
      .createIntake(body, "csrf")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).details).toEqual(details);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("keeps update/cancel/restore bound to their expected revision and key", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetcher);
    const update = {
      action: "restore" as const,
      expectedRevision: 4,
      idempotencyKey: "restore-4",
      allowDifferentRange: true,
    };
    await api.updateIntake("intake/a", update, "csrf");
    expect(fetcher.mock.calls[0][0]).toBe("/api/intake/intake%2Fa");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(update);
  });
});

import { readIntakeDraft, saveIntakeDraft } from "./intake-drafts";
import type { SavedDraft } from "./intake-drafts";
describe("resumable intake drafts", () => {
  function storage() {
    const entries = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    });
  }
  const draft: SavedDraft = {
    fields: {
      url: intake.submittedUrl,
      episodeId: "draft",
      kind: "already_cut",
      start: "0:00",
      end: "1:30",
      why: "Keep this context",
    },
    editing: null,
    baselineRevision: null,
    attempt: null,
  };
  it("keeps an Add draft separate from multiple edit drafts and preserves their original revision", () => {
    storage();
    saveIntakeDraft(draft);
    const first = { ...draft, editing: "first", baselineRevision: 2 };
    saveIntakeDraft(first);
    saveIntakeDraft({ ...draft, editing: "second", baselineRevision: 7 });
    expect(readIntakeDraft(null)).toEqual(draft);
    expect(readIntakeDraft("first")).toEqual(first);
    expect(readIntakeDraft("second")?.baselineRevision).toBe(7);
  });
  it("retains exact uncertain request/key across page reload and clears only its confirmed draft", () => {
    storage();
    saveIntakeDraft({ ...draft, editing: "other", baselineRevision: 4 });
    const pending = { ...draft, attempt: { id: null, body } };
    saveIntakeDraft(pending);
    expect(readIntakeDraft()?.attempt?.body).toEqual(body);
    saveIntakeDraft(null);
    expect(readIntakeDraft()).toBeNull();
    expect(readIntakeDraft(null)).toBeNull();
    expect(readIntakeDraft("other")?.baselineRevision).toBe(4);
  });
  it("fails safely when storage is disabled", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("Denied");
      },
      setItem: () => {
        throw new Error("Denied");
      },
    });
    expect(readIntakeDraft()).toBeNull();
    expect(() => saveIntakeDraft(draft)).not.toThrow();
  });
});
