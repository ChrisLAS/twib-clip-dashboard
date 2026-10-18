import { afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";

let runtime: Miniflare | undefined;
afterAll(async () => {
  await runtime?.dispose();
});

// Keep trigger bodies intact: their internal semicolons are not statement ends.
// These project migrations deliberately avoid CASE ... END in triggers.
function statements(sql: string): string[] {
  let remaining = sql.replace(/--[^\n]*/g, "").trim();
  const result: string[] = [];
  while (remaining) {
    const end = /^CREATE\s+TRIGGER\b/i.test(remaining)
      ? /\bEND\s*;/i.exec(remaining)
      : /;/.exec(remaining);
    if (!end) throw new Error("Unterminated migration statement");
    const length = end.index + end[0].length;
    result.push(remaining.slice(0, length));
    remaining = remaining.slice(length).trim();
  }
  return result;
}

it("enforces intake gates and current-intake guards through offline workerd D1", async () => {
  const work = fileURLToPath(
    new URL("../src/capture-jobs/intake-work.ts", import.meta.url),
  );
  const store = fileURLToPath(
    new URL("../src/capture-jobs/store.ts", import.meta.url),
  );
  const bundle = await build({
    stdin: {
      contents: `
        import {requestIntakeWork,retryIntakeWork,listIntakeWork} from ${JSON.stringify(work)};
        import {claimJob,acceptResult} from ${JSON.stringify(store)};
        export default {async fetch(request, bindings) {
          const {op,input,enabled=false,scope,now=100}=await request.json();
          const env={...bindings,INTAKE_WORK_REQUESTS_ENABLED:'true',
            CAPTURE_JOBS_ENABLED:enabled?'true':'false',
            CAPTURE_JOBS_GRANT_OPERATIONS:'capture,cut,plan',CAPTURE_JOBS_GRANT_EPISODE:'128'};
          try {
            let result;
            if(op==='request') result=await requestIntakeWork(env,'synthetic-intake',input,'owner',now);
            else if(op==='retry') result=await retryIntakeWork(env,'synthetic-intake',input.jobId,{expectedAttempt:0},'owner',now);
            else if(op==='claim') result=await claimJob(env.DB,input,now,scope);
            else if(op==='result') result=await acceptResult(env.DB,input,now);
            else if(op==='list') result=await listIntakeWork(env,'owner');
            else throw new Error('Unknown test operation');
            return Response.json(result);
          } catch(error) {
            return Response.json({code:error.code,message:error.message},{status:error.status??500});
          }
        }};`,
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
          name: "intake-runtime-test",
          modules: true,
          script: bundle.outputFiles[0].text,
          compatibilityDate: "2026-10-01",
          d1Databases: { DB: "intake-runtime-test-db" },
          outboundService: () => {
            throw new Error("Network access is forbidden in this offline test");
          },
        },
      ],
    }),
  );
  const db = await runtime.getD1Database("DB");
  const migrations = new URL("../migrations/", import.meta.url);
  const names = readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  expect(names.some((name) => name.startsWith("0018_"))).toBe(true);
  for (const name of names) {
    for (const statement of statements(
      readFileSync(new URL(name, migrations), "utf8"),
    )) {
      await db.prepare(statement).run();
    }
  }
  await db
    .prepare(
      "INSERT INTO episode_workspaces(id,data,status,is_active,revision) VALUES('synthetic-draft',?,'draft',1,1)",
    )
    .bind(
      JSON.stringify({
        id: "synthetic-draft",
        number: 128,
        title: "Synthetic draft",
      }),
    )
    .run();
  const intake = {
    id: "synthetic-intake",
    episodeId: "synthetic-draft",
    kind: "full_source",
    submittedUrl: "https://youtu.be/abcdefghijk",
    canonicalUrl: "https://youtu.be/abcdefghijk",
    provider: "youtube",
    inMs: null,
    outMs: null,
    whyItMatters: "Synthetic test only",
    status: "awaiting_processing",
    revision: 1,
    createdAt: "2026-10-16T00:00:00Z",
    updatedAt: "2026-10-16T00:00:00Z",
  };
  await db
    .prepare(
      "INSERT INTO manual_intake(id,owner,episode_id,canonical_url,in_ms,out_ms,status,revision,data) VALUES(?,'owner',?,?,NULL,NULL,'awaiting_processing',1,?)",
    )
    .bind(
      intake.id,
      intake.episodeId,
      intake.canonicalUrl,
      JSON.stringify(intake),
    )
    .run();
  const send = async (body: Record<string, unknown>, status = 200) => {
    const response = await runtime!.dispatchFetch("https://test.invalid/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, unknown>;
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  };
  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const scope = { episode: 128, intakeEnabled: true };
  const request = {
    op: "request",
    input: { expectedRevision: 1, priority: "normal" },
  };
  const saved = await send(request);
  expect(saved).toMatchObject({
    stage: "saved",
    code: "PROCESSING_DISABLED",
    episodeNumber: 128,
  });
  expect(await send(request)).toEqual(saved);
  expect(
    await send({ op: "claim", input: { request_id: uuid(1) }, scope }),
  ).toMatchObject({ claim: null });
  await send({ op: "retry", input: { jobId: saved.jobId } }, 503);
  // Merely enabling processing and replaying intent must not release saved work.
  expect(await send({ ...request, enabled: true })).toMatchObject({
    stage: "saved",
  });
  expect(
    await send({ op: "claim", input: { request_id: uuid(2) }, scope }),
  ).toMatchObject({ claim: null });
  const retry = { op: "retry", input: { jobId: saved.jobId }, enabled: true };
  expect(await send(retry)).toMatchObject({ stage: "queued" });
  expect(await send(retry)).toMatchObject({ stage: "queued" });
  for (const [n, deniedScope] of [
    [3, { episode: 127, intakeEnabled: true }],
    [4, { episode: 128, intakeEnabled: false }],
  ] as const) {
    expect(
      await send({
        op: "claim",
        input: { request_id: uuid(n) },
        scope: deniedScope,
      }),
    ).toMatchObject({ claim: null });
  }
  const claimRequest = { op: "claim", input: { request_id: uuid(5) }, scope };
  const claim = await send(claimRequest);
  expect(claim).toMatchObject({
    claim: { job_id: saved.jobId, lease_id: uuid(5) },
  });
  expect(await send(claimRequest)).toEqual(claim);
  const running = {
    delivery_id: uuid(6),
    job_id: saved.jobId,
    lease_id: uuid(5),
    state: "running",
    attempt: 1,
    code: "DOWNLOADING",
  };
  expect(await send({ op: "result", input: running })).toMatchObject({
    accepted: true,
  });
  await db
    .prepare(
      "UPDATE manual_intake SET revision=2,data=json_set(data,'$.revision',2,'$.whyItMatters','Changed synthetic intent') WHERE id=?",
    )
    .bind(intake.id)
    .run();
  await send(claimRequest, 409);
  await send({ op: "result", input: running }, 409);
  await send(
    { op: "result", input: { ...running, delivery_id: uuid(7) } },
    409,
  );
  expect(await send({ op: "list" })).toMatchObject({
    jobs: [{ stale: true, code: "INTAKE_SUPERSEDED" }],
  });
  expect(
    await db.prepare("SELECT count(*) n FROM capture_job_deliveries").first(),
  ).toEqual({ n: 1 });
  expect(
    await db.prepare("SELECT count(*) n FROM capture_jobs").first(),
  ).toEqual({ n: 1 });
  expect(
    await db.prepare("SELECT count(*) n FROM intake_work_requests").first(),
  ).toEqual({ n: 1 });
  expect(
    await db.prepare("SELECT count(*) n FROM inventory_reviews").first(),
  ).toEqual({ n: 0 });
  expect(
    await db.prepare("SELECT count(*) n FROM inventory_cut_requests").first(),
  ).toEqual({ n: 0 });
  expect(await db.prepare("SELECT count(*) n FROM renders").first()).toEqual({
    n: 0,
  });
}, 30000);
it("selects one owner range through real offline workerd D1 with planning disabled", async () => {
  const work = fileURLToPath(
    new URL("../src/capture-jobs/intake-work.ts", import.meta.url),
  );
  const store = fileURLToPath(
    new URL("../src/capture-jobs/store.ts", import.meta.url),
  );
  const contract = fileURLToPath(
    new URL("../src/inventory/contract.ts", import.meta.url),
  );
  const bundle = await build({
    stdin: {
      contents: `
    import {requestIntakeWork,advanceIntakeWork,listIntakeWork,selectIntakeRange} from ${JSON.stringify(work)};
    import {claimJob,acceptResult} from ${JSON.stringify(store)};
    import {inventoryEpisodeId} from ${JSON.stringify(contract)};
    const uuid = n => '00000000-0000-4000-8000-'+String(n).padStart(12,'0');
    export default {async fetch(request,{DB}) {
      const {op,input}=await request.json();
      const env={DB,INTAKE_WORK_REQUESTS_ENABLED:'true',CAPTURE_JOBS_ENABLED:'true',CUT_REQUESTS_ENABLED:'true',
        CUT_JOBS_ENABLED:'true',CUT_PLANNING_ENABLED:'false',CAPTURE_JOBS_GRANT_OPERATIONS:'capture,cut',
        CAPTURE_JOBS_GRANT_SOURCE_ID:'nomad:capture-worker',CAPTURE_JOBS_GRANT_SHOW:'twib',
        CAPTURE_JOBS_GRANT_SCOPES:'job:claim,job:result',CAPTURE_JOBS_GRANT_EPISODE:'128',
        CAPTURE_JOBS_GRANT_STARTS_AT:'2026-10-18T00:00:00Z',CAPTURE_JOBS_GRANT_EXPIRES_AT:'2026-10-18T02:00:00Z'};
      try {
        if(op==='seed') {
          const data={id:'manual-range-intake',episodeId:'draft',canonicalUrl:'https://youtu.be/abcdefghijk',revision:1,status:'awaiting_processing',inMs:null,outMs:null,whyItMatters:'Keep original notes'};
          await DB.prepare("INSERT INTO episode_workspaces(id,data,status,is_active,revision) VALUES('draft',?,'draft',1,1)").bind(JSON.stringify({id:'draft',number:128})).run();
          await DB.prepare("INSERT INTO manual_intake(id,owner,episode_id,canonical_url,in_ms,out_ms,status,revision,data) VALUES(?,'owner','draft',?,NULL,NULL,'awaiting_processing',1,?)").bind(data.id,data.canonicalUrl,JSON.stringify(data)).run();
          const w=await requestIntakeWork(env,data.id,{expectedRevision:1,priority:'normal'},'owner',1000);
          const lease=(await claimJob(DB,{request_id:uuid(1)},1001,{episode:128,intakeEnabled:true})).claim;
          const proof={version:1,job_id:w.jobId,ref:'new-review/'+w.jobId+'-a1.mp4',sha256:'a'.repeat(64),size_bytes:100,duration_seconds:600,show:'twib',episode:128,editorial_ready:false};
          await acceptResult(DB,{delivery_id:uuid(2),job_id:w.jobId,lease_id:lease.lease_id,state:'succeeded',attempt:1,code:null,capture:proof},1002);
          const item={id:'item_'+'b'.repeat(64),kind:'media',media:{ref:proof.ref,present:true,size_bytes:100,modified_at:null,duration_seconds:600},producer_record:{clip_id:'native',clip_uid:'native',source_long_clip_id:null,parent_clip_id:null},capture_evidence:[{artifact:'capture/synthetic.json',matches_observed_size:true,content_hash_verified:false,streams_reprobed:false,producer_sha256:proof.sha256}],observations:[],origins:[],processing_status:'captured',ready:false};
          const episode=await inventoryEpisodeId(128);
          await DB.batch([
            DB.prepare('INSERT INTO inventory_items(source_id,episode_id,item_id) VALUES(?,?,?)').bind('nomad:number-one',episode,item.id),
            DB.prepare("INSERT INTO inventory_snapshots(receipt_id,source_id,episode_id,digest,scan_id,sequence,envelope_hash,payload_hash,observed_ms,accepted_at,manifest_json,receipt_json) VALUES('receipt',?,?,'d','scan',1,'h','p',1,'2026-10-18T00:00:00Z','{}','{}')").bind('nomad:number-one',episode),
            DB.prepare('INSERT INTO inventory_observations(receipt_id,source_id,episode_id,item_id,sequence,item_json,observed_ms) VALUES(?,?,?,?,?,?,1)').bind('receipt','nomad:number-one',episode,item.id,1,JSON.stringify(item))
          ]);
          await advanceIntakeWork(env,w.jobId);
          return Response.json((await listIntakeWork(env,'owner')).jobs[0]);
        }
        const result=await selectIntakeRange(env,'manual-range-intake',input.jobId,input.selection,'owner',Date.parse('2026-10-18T01:00:00Z'));
        return Response.json(result);
      } catch(error) {return Response.json({code:error.code,message:error.message},{status:error.status??500});}
    }};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
  });
  const local = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "manual-range-test",
          modules: true,
          script: bundle.outputFiles[0].text,
          compatibilityDate: "2026-10-01",
          d1Databases: { DB: "manual-range-test" },
          outboundService: () => {
            throw new Error("Network forbidden");
          },
        },
      ],
    }),
  );
  try {
    const db = await local.getD1Database("DB");
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(migrations)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      for (const sql of statements(
        readFileSync(new URL(name, migrations), "utf8"),
      ))
        await db.prepare(sql).run();
    const send = (value: unknown) =>
      local.dispatchFetch("https://offline.test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
    const seed = await send({ op: "seed" });
    expect(seed.status, await seed.clone().text()).toBe(200);
    const view = (await seed.json()) as {
      jobId: string;
      rangeSelection: object;
    };
    const input = {
      jobId: view.jobId,
      selection: {
        ...view.rangeSelection,
        range: { kind: "range", startSeconds: 10, endSeconds: 30 },
      },
    };
    const responses = await Promise.all([
      send({ op: "select", input }),
      send({ op: "select", input }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const result = await responses[0].json();
    expect(await responses[1].json()).toEqual(result);
    expect(result).toMatchObject({ selectionOrigin: "owner_range" });
    const conflict = await send({
      op: "select",
      input: {
        ...input,
        selection: {
          ...input.selection,
          range: { kind: "range", startSeconds: 11, endSeconds: 30 },
        },
      },
    });
    expect(conflict.status).toBe(409);
    expect(
      await db.prepare("SELECT count(*) n FROM inventory_cut_requests").first(),
    ).toEqual({ n: 2 });
    expect(
      await db.prepare("SELECT count(*) n FROM capture_jobs").first(),
    ).toEqual({ n: 2 });
    expect(
      await db.prepare("SELECT count(*) n FROM inventory_reviews").first(),
    ).toEqual({ n: 0 });
  } finally {
    await local.dispose();
  }
});
