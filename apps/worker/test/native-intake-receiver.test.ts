import { describe, it, expect } from "vitest";
import {
  inventoryEpisodeId,
  validateInventory,
  type InventoryGrant,
  type InventoryManifest,
} from "../src/inventory/contract";
const start = Date.parse("2026-10-19T17:54:33Z"),
  end = Date.parse("2026-10-26T15:08:09Z");
async function fixture() {
  const episodeId = await inventoryEpisodeId(128);
  const grant: InventoryGrant = {
    sourceId: "nomad:number-one",
    episodeId,
    episodeNumber: 128,
    expiresAt: end,
    scope: "inventory:write",
    allowEditorialContext: false,
    originHosts: [],
    nativeIntakeContext: true,
  };
  const manifest: InventoryManifest = {
    schema: "number-one-twib-inventory/v1",
    source_id: grant.sourceId,
    episode: { id: episodeId, show: "twib", number: 128 },
    snapshot: {
      mode: "full",
      complete: false,
      allow_deletions: false,
      scope: "episode_media_and_allowlisted_local_artifacts",
      consistency: "metadata_double_scan_not_atomic",
      candidate_coverage: "partial",
    },
    coverage: [],
    items: [
      {
        id: "item_" + "a".repeat(64),
        kind: "media",
        producer_record: {
          record_kind: "processing-history",
          clip_id: "synthetic-native",
          parent_clip_id: null,
          first_seen_at: null,
          source_signature: null,
        },
        media: {
          ref: "new-review/synthetic.mp4",
          present: true,
          size_bytes: 1234,
          duration_seconds: 10,
          modified_at: "2026-10-19T17:54:33Z",
        },
        observations: [
          {
            artifact: null,
            status: "noted",
            context: {
              title: "Synthetic title",
              operator_note: "Keep this point",
              extended: "Public context",
            },
            timestamps: {},
          },
        ],
        origins: [
          {
            id: "origin_" + "b".repeat(64),
            url: "https://x.com/example/status/123456789",
          },
        ],
        processing_status: "unverified",
        ready: false,
      },
    ],
    warnings: ["native_pinboard_subset"],
    idempotency_digest: "sha256:" + "c".repeat(64),
    observed_at: "2026-10-19T17:54:33Z",
    scan_finished_at: "2026-10-19T17:54:33Z",
  };
  return { grant, manifest };
}
const validate = (m: InventoryManifest, g: InventoryGrant, at = start) =>
  validateInventory(m, m.idempotency_digest, g, at);
describe("bounded native intake content", () => {
  it("accepts only explicit capability, marker and approved native shape", async () => {
    const { manifest: m, grant: g } = await fixture();
    await expect(validate(m, g)).resolves.toBe(m);
    await expect(
      validate(m, { ...g, nativeIntakeContext: false }),
    ).rejects.toMatchObject({ status: 422 });
    m.warnings = [];
    await expect(validate(m, g)).rejects.toMatchObject({ status: 422 });
  });
  it("keeps metadata-only owner inventory passing with opt-in off and on", async () => {
    const { manifest: m, grant: g } = await fixture();
    m.warnings = [];
    m.items[0].origins = [];
    m.items[0].observations[0].context = {};
    for (const nativeIntakeContext of [false, true])
      await expect(validate(m, { ...g, nativeIntakeContext })).resolves.toBe(m);
  });
  it("refuses unauthorized context keys even when empty", async () => {
    for (const key of ["why", "snippet", "listen_for", "rationale", "query"]) {
      const { manifest: m, grant: g } = await fixture();
      m.items[0].observations[0].context[key] = "";
      await expect(validate(m, g)).rejects.toMatchObject({
        code: "INVENTORY_NATIVE_INTAKE_CONTEXT",
      });
    }
  });
  it("requires partial native media and does not infer native provenance from candidates", async () => {
    for (const change of [
      (m: InventoryManifest) => {
        m.snapshot.complete = true;
      },
      (m: InventoryManifest) => {
        delete m.items[0].producer_record;
      },
      (m: InventoryManifest) => {
        m.items[0].kind = "candidate";
        m.items[0].media = null;
        m.items[0].processing_status = "candidate";
      },
    ]) {
      const { manifest: m, grant: g } = await fixture();
      change(m);
      await expect(validate(m, g)).rejects.toMatchObject({
        code: "INVENTORY_NATIVE_INTAKE_SHAPE",
      });
    }
  });
  it("enforces fixed approval and existing grant expiry", async () => {
    const { manifest: m, grant: g } = await fixture();
    for (const at of [start - 1, end])
      await expect(validate(m, g, at)).rejects.toBeTruthy();
    await expect(validate(m, g, end - 1)).resolves.toBe(m);
    await expect(
      validate(m, { ...g, expiresAt: start }, start),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("retains exact origin and prose privacy checks", async () => {
    for (const url of [
      "https://example.com/public",
      "https://x.com.evil.example/a",
      "https://x.com/a?token=secret",
      "https://x.com/a#frag",
      "https://user:pass@x.com/a",
      "https://youtube.com/watch?v=abcdefghijk",
      "https://m.youtube.com/watch?v=abcdefghijk",
    ]) {
      const { manifest: m, grant: g } = await fixture();
      m.items[0].origins[0].url = url;
      await expect(validate(m, g)).rejects.toMatchObject({ status: 422 });
    }
    for (const note of [
      "Read /home/private/file",
      "See https://example.com/private",
      "x".repeat(4001),
    ]) {
      const { manifest: m, grant: g } = await fixture();
      m.items[0].observations[0].context.operator_note = note;
      await expect(validate(m, g)).rejects.toMatchObject({ status: 422 });
    }
    for (const host of [
      "youtu.be",
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "x.com",
      "www.x.com",
      "twitter.com",
      "www.twitter.com",
    ]) {
      const { manifest: m, grant: g } = await fixture();
      m.items[0].origins[0].url = `https://${host}/public`;
      await expect(validate(m, g)).resolves.toBe(m);
    }
  });
});
