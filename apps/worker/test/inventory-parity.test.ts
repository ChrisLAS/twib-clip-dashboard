import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  validateEnvelope,
  type InventoryEnvelope,
  type InventoryGrant,
} from "../src/inventory/contract";
const review = new URL("../../../docs/number-one-parity/", import.meta.url);
const vectors = JSON.parse(
  readFileSync(new URL("reference-policy-vectors.json", review), "utf8"),
) as {
  allowed: { ref: string; stored_ref: string }[];
  rejected: { ref: string }[];
};
const historical = JSON.parse(
  readFileSync(new URL("regression-results.json", review), "utf8"),
) as { case: string; receiver?: { status: number; code: string } }[];
const now = Date.parse("2026-10-13T12:00:00Z");
function load(name: string): InventoryEnvelope {
  return JSON.parse(
    readFileSync(new URL(`regression-fixtures/${name}.json`, review), "utf8"),
  ) as InventoryEnvelope;
}
function grant(envelope: InventoryEnvelope): InventoryGrant {
  // Synthetic fixture grants only. This is not an authentication adapter or a
  // production policy that trusts manifest-supplied hosts.
  return {
    sourceId: envelope.manifest.source_id,
    episodeId: envelope.manifest.episode.id,
    episodeNumber: 127,
    expiresAt: now + 60000,
    scope: "inventory:write",
    allowEditorialContext: true,
    originHosts: [
      ...new Set(
        envelope.manifest.items.flatMap((item) =>
          item.origins.map((origin) => new URL(origin.url).hostname),
        ),
      ),
    ],
  };
}
describe("reviewed producer/receiver parity fixtures", () => {
  for (const row of historical.filter((row) => row.receiver)) {
    it(`pins ${row.case} receiver outcome without weakening rejection policy`, async () => {
      const envelope = load(row.case);
      const result = validateEnvelope(
        envelope,
        envelope.scan_id,
        grant(envelope),
        now,
      );
      if (row.case === "percent_filename") {
        const accepted = await result;
        expect(accepted.manifest.items[0].media?.ref).toBe("clip%25.mp4");
        expect(accepted).toEqual(envelope);
      } else await expect(result).rejects.toMatchObject(row.receiver!);
    });
  }
});
describe("literal relative references with bounded safety inspection", () => {
  it.each(vectors.allowed)(
    "preserves benign literal reference $ref",
    async ({ ref, stored_ref }) => {
      const envelope = load("percent_filename");
      envelope.manifest.items[0].media!.ref = ref;
      const accepted = await validateEnvelope(
        envelope,
        envelope.scan_id,
        grant(envelope),
        now,
      );
      expect(accepted.manifest.items[0].media!.ref).toBe(stored_ref);
      expect(accepted.manifest.items[0].id).toBe(envelope.manifest.items[0].id);
    },
  );
  it.each(vectors.rejected)(
    "rejects unsafe interpretation of $ref",
    async ({ ref }) => {
      const envelope = load("percent_filename");
      envelope.manifest.items[0].media!.ref = ref;
      await expect(
        validateEnvelope(envelope, envelope.scan_id, grant(envelope), now),
      ).rejects.toMatchObject({ status: 422 });
    },
  );
});
