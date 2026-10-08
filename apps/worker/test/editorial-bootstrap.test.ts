import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { prepareEditorialBootstrap } from "../src/editorial-bootstrap";
const input = {
  expectedRevision: 0,
  idempotencyKey: "synthetic-bootstrap-key",
  action: "replace",
  reason: "Explicit fictional owner instruction",
  scope: "global",
  rules: [
    {
      id: "synthetic-rule",
      text: "Preserve qualifications.",
      scope: "global",
      episodeId: null,
      renderId: null,
      evidenceIds: [],
    },
  ],
};
function database() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).sort())
    db.exec(readFileSync(new URL(f, dir), "utf8"));
  return db;
}
describe("explicit private editorial bootstrap", () => {
  it("rejects non-fresh, inferred or incorrectly scoped requests", async () => {
    await expect(
      prepareEditorialBootstrap({ ...input, expectedRevision: 1 }, "owner"),
    ).rejects.toMatchObject({ code: "INVALID_BOOTSTRAP" });
    await expect(
      prepareEditorialBootstrap(
        {
          ...input,
          rules: [{ ...input.rules[0], evidenceIds: ["fabricated"] }],
        },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "INVALID_BOOTSTRAP" });
    await expect(prepareEditorialBootstrap(input, "")).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
    });
  });
  it("requires existing review principal, retains honest actor and cannot replace newer guidance", async () => {
    const db = database();
    try {
      const prepared = await prepareEditorialBootstrap(
        input,
        "verified-fixture-owner",
      );
      db.prepare(prepared.sql).run(...prepared.params);
      expect(
        db.prepare("SELECT count(*) AS n FROM editorial_profiles").get()?.n,
      ).toBe(0);
      db.prepare("INSERT INTO episodes VALUES('ep', '{}')").run();
      db.prepare(
        "INSERT INTO clips(id,episode_id,data) VALUES('clip','ep','{}')",
      ).run();
      db.prepare(
        "INSERT INTO renders(id,clip_id,data) VALUES('render','clip','{}')",
      ).run();
      db.prepare(
        "INSERT INTO review_events VALUES('review','op','render',0,'up','','','verified-fixture-owner','2026-01-01','fp')",
      ).run();
      db.prepare(prepared.sql).run(...prepared.params);
      expect(
        db.prepare("SELECT actor FROM editorial_events").get()?.actor,
      ).toBe("assistant_bootstrap");
      expect(
        db.prepare("SELECT version FROM editorial_profiles").get()?.version,
      ).toBe(1);
      db.prepare(prepared.sql).run(...prepared.params);
      const changed = await prepareEditorialBootstrap(
        {
          ...input,
          idempotencyKey: "another-request-key",
          rules: [{ ...input.rules[0], text: "A different instruction" }],
        },
        "verified-fixture-owner",
      );
      db.prepare(changed.sql).run(...changed.params);
      expect(
        db.prepare("SELECT count(*) AS n FROM editorial_events").get()?.n,
      ).toBe(1);
      expect(
        db.prepare(prepared.reconcileSql).get(...prepared.reconcileParams)
          ?.fingerprint,
      ).toBe(prepared.requestFingerprint);
      expect(() =>
        db.exec("UPDATE editorial_events SET actor='owner'"),
      ).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});
