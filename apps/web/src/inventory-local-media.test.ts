import { describe, expect, it } from "vitest";
import type { InventoryRecordItem } from "./inventory-local-media";
import {
  inventoryScopeKey,
  matchEpisodeFile,
  matchExplicitFile,
  playbackEligible,
} from "./inventory-local-media";
function record(
  ref = "new-review/café%20literal.mp4",
  size = 12,
): InventoryRecordItem {
  return {
    id: "item_" + "1".repeat(64),
    readiness: "not_evaluated",
    conflictingLatestObservations: false,
    variantsTruncated: false,
    variants: [
      {
        sequence: 3,
        receiptId: "synthetic",
        observedAt: "2026-10-13T00:00:00Z",
        receivedAt: "2026-10-13T00:00:00Z",
        receiptComplete: false,
        receiptScope: "episode_media_and_allowlisted_local_artifacts",
        item: {
          id: "item_" + "1".repeat(64),
          kind: "media",
          media: {
            ref,
            present: true,
            size_bytes: size,
            modified_at: null,
            duration_seconds: null,
          },
          processing_status: "captured_observed",
          ready: false,
          origins: [],
          observations: [],
        },
      },
    ],
  };
}
function file(path: string, size = 12) {
  return {
    name: path.split("/").at(-1)!,
    size,
    lastModified: 0,
    webkitRelativePath: path,
  };
}
describe("explicit local inventory media", () => {
  it("matches literal Unicode and percent references without decoding", () => {
    expect(
      matchEpisodeFile(
        record(),
        [file("127/new-review/café%20literal.mp4")],
        127,
      ).state,
    ).toBe("matched");
    expect(
      matchEpisodeFile(record(), [file("127/new-review/café literal.mp4")], 127)
        .state,
    ).toBe("selection_needed");
  });
  it("never guesses by basename, wrong directory or wrong episode", () => {
    for (const path of [
      "127/elsewhere/café%20literal.mp4",
      "128/new-review/café%20literal.mp4",
      "TWIB/127/new-review/café%20literal.mp4",
      "café%20literal.mp4",
    ])
      expect(matchEpisodeFile(record(), [file(path)], 127).state).toBe(
        "selection_needed",
      );
  });
  it("rejects duplicate exact matches even if one has the expected size", () => {
    expect(
      matchEpisodeFile(
        record(),
        [
          file("127/new-review/café%20literal.mp4"),
          file("127/new-review/café%20literal.mp4", 14),
        ],
        127,
      ).state,
    ).toBe("ambiguous");
  });
  it("requires observed size and treats mtime as advisory", () => {
    expect(
      matchEpisodeFile(
        record(),
        [file("127/new-review/café%20literal.mp4", 13)],
        127,
      ).state,
    ).toBe("size_mismatch");
    const r = record();
    r.variants[0].item.media!.modified_at = "2026-10-13T00:00:00Z";
    expect(
      matchEpisodeFile(r, [file("127/new-review/café%20literal.mp4")], 127),
    ).toMatchObject({ state: "matched", mtimeDiffers: true });
  });
  it.each([
    "incomplete",
    "unverified",
    "quarantined",
    "missing",
    "failed",
    "candidate",
  ] as const)("excludes %s from playback", (status) => {
    const r = record();
    r.variants[0].item.processing_status = status;
    expect(playbackEligible(r)).toBe(false);
  });
  it.each([
    "x.mp4.part",
    "x.json",
    "../x.mp4",
    "/x.mp4",
    "a//x.mp4",
    "a/./x.mp4",
    "a\\x.mp4",
  ])("rejects partial/unknown/unsafe %s", (ref) =>
    expect(playbackEligible(record(ref))).toBe(false),
  );
  it("rejects absent, unknown-size and ambiguous source observations", () => {
    const absent = record();
    absent.variants[0].item.media!.present = false;
    const unknown = record();
    unknown.variants[0].item.media!.size_bytes = null;
    const multi = record();
    multi.variants.push(multi.variants[0]);
    for (const r of [
      absent,
      unknown,
      multi,
      { ...record(), conflictingLatestObservations: true },
      { ...record(), variantsTruncated: true },
    ])
      expect(playbackEligible(r)).toBe(false);
  });
  it.each(["mp4", "webm", "mkv", "mp3", "m4a", "ogg", "opus"])(
    "allows %s without claiming decoder support",
    (suffix) =>
      expect(playbackEligible(record(`new-review/x.${suffix}`))).toBe(true),
  );
  it("single-file selection requires an explicit full-reference binding", () => {
    expect(
      matchExplicitFile(
        record(),
        file("café%20literal.mp4"),
        "café%20literal.mp4",
      ).state,
    ).toBe("selection_needed");
    expect(
      matchExplicitFile(
        record(),
        file("café%20literal.mp4"),
        "new-review/café%20literal.mp4",
      ).state,
    ).toBe("matched");
  });
  it("identity includes source and episode; rename is a different record", () => {
    expect(inventoryScopeKey("a", "ep127", "id")).not.toBe(
      inventoryScopeKey("b", "ep127", "id"),
    );
    expect(inventoryScopeKey("a", "ep127", "id")).not.toBe(
      inventoryScopeKey("a", "ep128", "id"),
    );
    expect(inventoryScopeKey("a", "ep127", "id")).not.toBe(
      inventoryScopeKey("a", "ep127", "renamed"),
    );
  });
});
