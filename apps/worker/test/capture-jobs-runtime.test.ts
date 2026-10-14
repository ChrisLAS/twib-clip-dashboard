import { afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
let runtime: Miniflare | undefined;
afterAll(async () => {
  await runtime?.dispose();
});
it("claims and acknowledges through actual offline workerd D1 transactions", async () => {
  const source = fileURLToPath(
    new URL("../src/capture-jobs/store.ts", import.meta.url),
  );
  const bundle = await build({
    stdin: {
      contents: `import {createJob,claimJob,acceptResult} from ${JSON.stringify(source)}; export default {async fetch(r,env){const {op,input}=await r.json();return Response.json(await ({create:createJob,claim:claimJob,result:acceptResult}[op])(env.DB,input,op==='create'?'owner':undefined));}}`,
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
          name: "capture-test",
          modules: true,
          script: bundle.outputFiles[0].text,
          compatibilityDate: "2026-10-01",
          d1Databases: { DB: "capture-test-db" },
        },
      ],
    }),
  );
  const db = await runtime.getD1Database("DB");
  const migration = readFileSync(
    new URL("../migrations/0012_capture_jobs.sql", import.meta.url),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  const [tables, ...triggers] = migration.split(/(?=CREATE TRIGGER)/);
  for (const statement of tables.split(";").filter((s) => s.trim()))
    await db.prepare(statement).run();
  for (const statement of triggers) await db.prepare(statement.trim()).run();
  const send = async (op: string, input: unknown) => {
    const response = await runtime!.dispatchFetch("https://test.invalid/", {
      method: "POST",
      body: JSON.stringify({ op, input }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const job_id = "00000000-0000-4000-8000-000000000001",
    request_id = "00000000-0000-4000-8000-000000000002";
  await send("create", {
    job_id,
    show: "twib",
    episode: 127,
    url: "https://youtu.be/abcdefghijk",
    reported_by: "number-one",
  });
  const claim = await send("claim", { request_id });
  expect(await send("claim", { request_id })).toEqual(claim);
  const delivery = {
    delivery_id: "00000000-0000-4000-8000-000000000003",
    job_id,
    lease_id: request_id,
    state: "succeeded",
    attempt: 1,
    code: null,
  };
  const [ack, concurrentAck] = await Promise.all([
    send("result", delivery),
    send("result", delivery),
  ]);
  expect(concurrentAck).toEqual(ack);
  expect(await send("result", delivery)).toEqual(ack);
  expect(
    (
      await db
        .prepare("SELECT state FROM capture_jobs")
        .first<{ state: string }>()
    )?.state,
  ).toBe("succeeded");
}, 20000);
