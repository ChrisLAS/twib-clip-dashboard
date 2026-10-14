// Real TypeScript persistence + Python outbound poller + synthetic ffmpeg cut.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import process from "node:process";
import console from "node:console";
const root = await mkdtemp(join(tmpdir(), "cut-pipe-"));
const sqlite = new DatabaseSync(":memory:");
let child;
try {
  const episode = join(root, "episodes", "127"),
    workspace = join(root, "workspace");
  await mkdir(episode, { recursive: true });
  await mkdir(workspace);
  const source = join(episode, "original.mp4");
  execFileSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=22050",
    "-t",
    "3",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    source,
  ]);
  const sha = createHash("sha256")
    .update(await readFile(source))
    .digest("hex");
  const parent = {
    clip_id: "native-parent",
    current_path: source,
    file: source,
    source_long_clip_id: "root-source",
    approval: "approved",
  };
  await writeFile(
    join(workspace, "processing-history.json"),
    JSON.stringify({ local_files: { "native-parent": parent } }),
  );
  await writeFile(
    join(workspace, "twib-state.json"),
    JSON.stringify({
      episode_number: 127,
      episode_dir: episode,
      base_dropbox_dir: join(root, "episodes"),
      episode_dir_name_format: "%03d",
      episode_locked: true,
    }),
  );
  for (const dir of ["poll", "worker"])
    await mkdir(join(root, dir), { mode: 0o700 });
  await build({
    stdin: {
      contents: `export {saveInventoryReview,inventoryVersion} from ${JSON.stringify(resolve("apps/worker/src/inventory/review.ts"))}; export {enqueueCut,readCut,cutView} from ${JSON.stringify(resolve("apps/worker/src/capture-jobs/cut.ts"))}; export {claimJob,acceptResult} from ${JSON.stringify(resolve("apps/worker/src/capture-jobs/store.ts"))}; export {acceptInventory} from ${JSON.stringify(resolve("apps/worker/src/inventory/store.ts"))}; export {semanticHash} from ${JSON.stringify(resolve("apps/worker/src/inventory/contract.ts"))};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    outfile: join(root, "store.mjs"),
    platform: "node",
    format: "esm",
  });
  const server = await import(pathToFileURL(join(root, "store.mjs")));
  for (const name of [
    "0011_number_one_inventory.sql",
    "0012_capture_jobs.sql",
    "0013_inventory_review.sql",
    "0014_inventory_cut_requests.sql",
  ])
    sqlite.exec(await readFile(join("apps/worker/migrations", name), "utf8"));
  class Statement {
    constructor(sql) {
      this.sql = sql;
      this.values = [];
    }
    bind(...values) {
      this.values = values;
      return this;
    }
    async first() {
      return sqlite.prepare(this.sql).get(...this.values) ?? null;
    }
    async all() {
      return { results: sqlite.prepare(this.sql).all(...this.values) };
    }
    async run() {
      return sqlite.prepare(this.sql).run(...this.values);
    }
  }
  const db = {
    prepare: (sql) => new Statement(sql),
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const manifest = JSON.parse(
    await readFile("apps/worker/test/fixtures/inventory.example.json", "utf8"),
  );
  const item = {
    id: "item_" + "a".repeat(64),
    kind: "media",
    media: {
      ref: "original.mp4",
      present: true,
      size_bytes: (await stat(source)).size,
      modified_at: null,
      duration_seconds: 3,
    },
    observations: [],
    origins: [],
    processing_status: "captured_observed",
    ready: false,
    producer_record: {
      clip_id: "native-parent",
      record_kind: "processing-history",
      first_seen_at: null,
      source_signature: null,
      parent_clip_id: null,
    },
    capture_evidence: [
      {
        artifact: "fixture.capture.json",
        matches_observed_size: true,
        content_hash_verified: false,
        streams_reprobed: false,
        producer_sha256: sha,
      },
    ],
  };
  manifest.items = [item];
  manifest.observed_at = "2026-10-13T00:00:00Z";
  manifest.scan_finished_at = manifest.observed_at;
  manifest.idempotency_digest =
    "sha256:" + (await server.semanticHash(manifest));
  const now = Date.parse("2026-10-13T00:00:00Z"),
    scan = "00000000-0000-4000-8000-000000000101";
  await server.acceptInventory(
    db,
    {
      schema: "number-one-inventory-envelope/v2",
      scan_id: scan,
      sequence: 1,
      manifest,
    },
    scan,
    {
      sourceId: manifest.source_id,
      episodeId: manifest.episode.id,
      episodeNumber: 127,
      scope: "inventory:write",
      expiresAt: now + 86400000,
      allowEditorialContext: true,
      originHosts: ["www.youtube.com", "example.com"],
    },
    now,
  );
  const input = {
    operationId: "00000000-0000-4000-8000-000000000102",
    episodeNumber: 127,
    itemId: item.id,
    expectedRevision: 0,
    expectedVersion: await server.inventoryVersion(item),
    action: "decision",
    notes: "Preserve qualification",
    status: "cut_down",
    reason: "Complete two-second fixture",
    cutSpec: { kind: "range", startSeconds: 0.5, endSeconds: 2.5 },
  };
  const review = await server.saveInventoryReview(
    db,
    input,
    "fixture-owner",
    now,
  );
  assert.equal(review.cutRequestId, input.operationId);
  await server.enqueueCut(db, review.cutRequestId, "fixture-owner", now);
  const python = `import sys,json,pathlib,os\nsys.path.insert(0,sys.argv[2])\nimport poller\nr=pathlib.Path(sys.argv[1])\nclass Transport:\n def __init__(self):self.lost=False\n def post(self,route,payload):\n  print(json.dumps(dict(route=route,payload=payload)),flush=True)\n  response=json.loads(sys.stdin.readline())\n  if route=='result' and payload.get('result') and not self.lost:\n   self.lost=True;raise OSError('synthetic lost acknowledgement')\n  return response\nconfig=dict(enabled=True,cut_enabled=True,job_kind='cut',history_file=str(r/'workspace/processing-history.json'),state_dir=str(r/'poll'),worker_state_dir=str(r/'worker'),workspace=str(r/'workspace'),origin='https://invalid.test',job_credential_file='UNUSED',show='twib',episode=127,max_bytes=10000000,max_duration_seconds=180)\nclient=poller.Poller(config,transport=Transport(),now=lambda:${now / 1000})\ntry:\n try:client.tick();raise AssertionError('lost ack required')\n except OSError:pass\n assert client.tick()=='delivered'\n assert client.tick()=='empty'\n print(json.dumps(dict(done=True)),flush=True)\nfinally:client.close()\n`;
  child = spawn(
    "python3",
    [
      "-B",
      "-u",
      "-c",
      python,
      root,
      resolve(
        process.env.NOMAD_CUT_SOURCE || "../nomad-cut-client/capture-jobs",
      ),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "",
    done = false;
  const deliveries = [];
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr)),
    );
  });
  finished.catch(() => {});
  for await (const line of createInterface({ input: child.stdout })) {
    const message = JSON.parse(line);
    if (message.done) {
      done = true;
      continue;
    }
    const response =
      message.route === "claim"
        ? await server.claimJob(db, message.payload, now)
        : await server.acceptResult(db, message.payload, now);
    assert.deepEqual(
      message.route === "claim"
        ? await server.claimJob(db, message.payload, now + 1)
        : await server.acceptResult(db, message.payload, now + 1),
      response,
    );
    if (message.route === "result") deliveries.push(message.payload);
    child.stdin.write(JSON.stringify(response) + "\n");
  }
  await finished;
  assert.ok(done);
  const ready = deliveries.filter((d) => d.result);
  assert.equal(ready.length, 2);
  assert.deepEqual(ready[0], ready[1]);
  const view = server.cutView(await server.readCut(db, input.operationId));
  assert.equal(view.state, "needs_review");
  assert.equal(view.derivative.approval, "unreviewed");
  assert.equal(view.derivative.source_long_clip_id, "root-source");
  assert.equal(view.derivative.parent_clip_id, "native-parent");
  assert.equal(view.derivative.source_sha256, sha);
  assert.deepEqual(
    JSON.parse(
      await readFile(join(workspace, "processing-history.json"), "utf8"),
    ).local_files["native-parent"],
    parent,
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
    sha,
  );
  assert.equal(
    sqlite.prepare("SELECT attempt FROM capture_jobs").get().attempt,
    1,
  );
  assert.deepEqual(
    await server.saveInventoryReview(db, input, "fixture-owner", now),
    review,
  );
  console.log(
    "PASS: persisted review → immutable cut request → actual Python outbound poller → bounded synthetic ffmpeg derivative → native child history → matched server result; lost acknowledgement replay without recut; original/history parent unchanged; unreviewed lineage. No HTTP, credentials or live media.",
  );
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  sqlite.close();
  await rm(root, { recursive: true, force: true });
}
