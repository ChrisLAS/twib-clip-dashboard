import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  containsRecognizableSecret,
  redactRecognizableSecrets,
} from "../src/inventory/secrets";
import {
  validateEnvelope,
  type InventoryEnvelope,
  type InventoryGrant,
} from "../src/inventory/contract";
const corpus = JSON.parse(
  readFileSync(
    new URL(
      "../../../docs/number-one-parity/secret-policy-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  redaction_cases: { id: string; text: string; redacted: string }[];
  detector_cases: { id: string; text: string; contains_secret: boolean }[];
  integration_cases: {
    id: string;
    field: string;
    value: string;
    expected_code: string;
  }[];
};
const now = Date.parse("2026-10-13T12:00:00Z");
describe("shared language-neutral secret policy", () => {
  it.each(corpus.detector_cases)("$id", ({ text, contains_secret }) => {
    expect(containsRecognizableSecret(text)).toBe(contains_secret);
  });
  it.each(corpus.redaction_cases)(
    "redaction span $id",
    ({ text, redacted }) => {
      expect(redactRecognizableSecrets(text)).toBe(redacted);
      expect(containsRecognizableSecret(redacted)).toBe(false);
      expect(redactRecognizableSecrets(redacted)).toBe(redacted);
    },
  );
  it.each(corpus.integration_cases)(
    "rejects known complete/queueable producer case $id",
    async ({ field, value, expected_code }) => {
      const envelope = JSON.parse(
        readFileSync(
          new URL(
            "../../../docs/number-one-parity/regression-fixtures/percent_filename.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as InventoryEnvelope;
      const item = envelope.manifest.items[0];
      if (field === "ref") item.media!.ref = value;
      else if (field === "origin")
        item.origins = [{ id: `origin_${"a".repeat(64)}`, url: value }];
      else
        item.observations = [
          {
            artifact: "transcripts/source-watch.json",
            status: "candidate",
            timestamps: {},
            context: { title: value },
          },
        ];
      const grant: InventoryGrant = {
        sourceId: envelope.manifest.source_id,
        episodeId: envelope.manifest.episode.id,
        episodeNumber: 127,
        scope: "inventory:write",
        expiresAt: now + 60000,
        allowEditorialContext: true,
        originHosts: ["example.com"],
      };
      await expect(
        validateEnvelope(envelope, envelope.scan_id, grant, now),
      ).rejects.toMatchObject({ status: 422, code: expected_code });
    },
  );
});
