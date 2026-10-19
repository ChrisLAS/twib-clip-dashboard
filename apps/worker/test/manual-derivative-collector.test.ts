import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
import {
  validateInventory,
  type InventoryManifest,
  type InventoryGrant,
} from "../src/inventory/contract";
import {
  inventoryVersionBasis,
  versionBasisSql,
} from "../src/inventory/review";
import { DatabaseSync } from "node:sqlite";
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/manual-derivative-collector.json", import.meta.url),
    "utf8",
  ),
) as InventoryManifest;
it("accepts the actual synthetic native collector output with no fabricated capture evidence", async () => {
  const now = Date.parse(fixture.scan_finished_at) + 1000;
  const grant: InventoryGrant = {
    sourceId: fixture.source_id,
    episodeId: fixture.episode.id,
    episodeNumber: 128,
    expiresAt: now + 60000,
    scope: "inventory:write",
    allowEditorialContext: false,
    originHosts: [],
  };
  await expect(
    validateInventory(fixture, fixture.idempotency_digest, grant, now),
  ).resolves.toEqual(fixture);
  const child = fixture.items.find(
    (i) => i.producer_record?.manual_derivative,
  )!;
  expect(child).toBeTruthy();
  expect(child.capture_evidence ?? []).toHaveLength(0);
  expect(child.processing_status).toBe("unverified");
  expect(child.ready).toBe(false);
  const basis = JSON.parse(inventoryVersionBasis(child));
  expect(basis.hashes).toEqual([
    child.producer_record!.manual_derivative!.derivative_sha256,
  ]);
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("CREATE TABLE observed(item_json TEXT)");
    sqlite.prepare("INSERT INTO observed VALUES(?)").run(JSON.stringify(child));
    const sql = sqlite
      .prepare("SELECT " + versionBasisSql("o") + " AS basis FROM observed o")
      .get() as { basis: string };
    expect(sql.basis).toBe(inventoryVersionBasis(child));
  } finally {
    sqlite.close();
  }
  const changed = structuredClone(child);
  changed.producer_record!.manual_derivative!.derivative_sha256 = "c".repeat(
    64,
  );
  expect(inventoryVersionBasis(changed)).not.toBe(inventoryVersionBasis(child));
});
