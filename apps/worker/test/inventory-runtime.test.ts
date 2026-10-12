import { afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
let runtime: Miniflare | undefined;
afterAll(async () => {
  await runtime?.dispose();
});
it("validates and commits inventory in workerd/D1 without runtime code generation", async () => {
  const source = fileURLToPath(
    new URL("../src/inventory/store.ts", import.meta.url),
  );
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/inventory.example.json", import.meta.url),
      "utf8",
    ),
  );
  const grant = {
    sourceId: fixture.source_id,
    episodeId: fixture.episode.id,
    episodeNumber: 127,
    expiresAt: Date.parse("2026-10-12T12:01:00Z"),
    scope: "inventory:write",
    allowEditorialContext: true,
    originHosts: ["www.youtube.com"],
  };
  // Synthetic test harness only. Production worker has no route to this operation.
  const bundle = await build({
    stdin: {
      contents: `import { acceptInventory } from ${JSON.stringify(source)}; export default { async fetch(request, env) { const data = await request.json(); try { return Response.json(await acceptInventory(env.DB, data, data.scan_id, ${JSON.stringify(grant)}, ${Date.parse("2026-10-12T12:00:00Z")})); } catch(error) { return Response.json({code: error.code ?? 'unexpected'}, {status: error.status ?? 500}); } } };`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "inventory-test",
          modules: true,
          script: bundle.outputFiles[0].text,
          compatibilityDate: "2026-10-01",
          d1Databases: { DB: "inventory-test-db" },
        },
      ],
    }),
  );
  const db = await runtime.getD1Database("DB");
  const migration = readFileSync(
    new URL("../migrations/0011_number_one_inventory.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration
    .replace(/--[^\n]*/g, "")
    .split(/;(?=\s*(?:CREATE|$))/)
    .filter((part) => part.trim()))
    await db.prepare(statement).run();
  const send = (payload: unknown) =>
    runtime!.dispatchFetch("https://local.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  const envelope = {
    schema: "number-one-inventory-envelope/v2",
    scan_id: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    manifest: fixture,
  };
  const first = await send(envelope);
  expect(first.status).toBe(200);
  const receipt = await first.json();
  expect(await (await send(envelope)).json()).toEqual(receipt);
  fixture.items[0].processing_status = "failed";
  const conflict = await send(envelope);
  expect(conflict.status).toBe(409);
  const digestConflict = await send({
    ...envelope,
    scan_id: "00000000-0000-4000-8000-000000000002",
    sequence: 2,
  });
  expect(digestConflict.status).toBe(409);
  expect(await digestConflict.json()).toEqual({
    code: "INVENTORY_DIGEST_CONFLICT",
  });
  expect(
    (
      await db
        .prepare("SELECT count(*) AS n FROM inventory_snapshots")
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS n FROM inventory_observations")
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
}, 30000);
