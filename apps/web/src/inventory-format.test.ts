import { describe, expect, it } from "vitest";
import { INVENTORY_STATUSES } from "@twib/shared";
import {
  inventoryBytes,
  inventoryStatusLabels,
  inventoryStatusNotes,
  inventoryTimestamp,
  inventoryView,
  inventoryViewUrl,
} from "./inventory-format";
describe("read-only inventory presentation", () => {
  it("labels exactly the accepted processing states", () => {
    expect(Object.keys(inventoryStatusLabels).sort()).toEqual(
      [...INVENTORY_STATUSES].sort(),
    );
    for (const s of INVENTORY_STATUSES)
      expect(inventoryStatusNotes[s]).toBeTruthy();
  });
  it("does not call capture observations media-ready", () => {
    expect(inventoryStatusLabels.captured_observed).toBe("Capture observed");
    expect(inventoryStatusNotes.captured_observed).toContain("not a playback");
  });
  it.each([null, undefined, NaN, -1])(
    "keeps missing file size distinct from zero %s",
    (n) => expect(inventoryBytes(n)).toBe("Size not recorded"),
  );
  it("formats bytes without inventing media duration", () => {
    expect(inventoryBytes(0)).toBe("0 B");
    expect(inventoryBytes(1024)).toBe("1 KiB");
  });
  it("uses explicit UTC and rejects invalid timestamps", () => {
    expect(inventoryTimestamp("2026-01-12T18:00:00Z")).toContain("18:00 UTC");
    expect(inventoryTimestamp("invalid")).toBe("Not recorded");
    expect(inventoryTimestamp(null)).toBe("Not recorded");
  });
  it("preserves episode selection and drops clip fragment on explicit workspace navigation", () => {
    const url = "https://example.com/?episode=ep-126#clip/c1";
    expect(inventoryViewUrl(url, "inventory")).toBe(
      "/?episode=ep-126&view=inventory",
    );
    expect(
      inventoryViewUrl(
        "https://example.com/?episode=ep-126&view=inventory",
        "slate",
      ),
    ).toBe("/?episode=ep-126");
  });
  it("URL controls Back/Forward view", () => {
    expect(inventoryView("https://example.com/?view=inventory")).toBe(
      "inventory",
    );
    expect(inventoryView("https://example.com/?view=unrecognized")).toBe(
      "slate",
    );
  });
});
