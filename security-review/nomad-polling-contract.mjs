// Actual Python client and TypeScript store through pipes; fake executor, no HTTP.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";
import { build } from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "nomad-polling-contract-"));
await chmod(temp, 0o700);
const sqlite = new DatabaseSync(":memory:");
let child;
try {
  const names = [
    "capture-jobs/poller.py",
    "capture-jobs/worker.py",
    "scripts/number_one_media_capture.py",
    "scripts/number_one_episode_guard.py",
    "scripts/twib_safety.py",
  ];
  const read = `import pathlib,json,base64\nr=pathlib.Path('/home/chrisf/build/nomad-nixos/hosts/nomad/hermes-agents/number-one')\npaths=${JSON.stringify(names)}\nprint(json.dumps({p:base64.b64encode((r/p).read_bytes()).decode() for p in paths}))\n`;
  const sources = JSON.parse(
    execFileSync(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ControlPath=none",
        "-o",
        "PermitLocalCommand=no",
        "Nomad",
        "python3 -",
      ],
      { input: read, encoding: "utf8", timeout: 30000 },
    ),
  );
  assert.deepEqual(Object.keys(sources).sort(), [...names].sort());
  for (const [name, bytes] of Object.entries(sources)) {
    const path = join(temp, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.from(bytes, "base64"), { mode: 0o600 });
  }
  await build({
    entryPoints: [join(root, "apps/worker/src/capture-jobs/store.ts")],
    bundle: true,
    outfile: join(temp, "store.mjs"),
    platform: "node",
    format: "esm",
  });
  const { createJob, claimJob, acceptResult } = await import(
    pathToFileURL(join(temp, "store.mjs")).href
  );
  sqlite.exec(
    await readFile(
      join(root, "apps/worker/migrations/0012_capture_jobs.sql"),
      "utf8",
    ),
  );
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
        const out = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const now = 1700000000000,
    jobs = [
      "00000000-0000-4000-8000-000000000101",
      "00000000-0000-4000-8000-000000000102",
    ];
  const input = (job_id) => ({
    job_id,
    show: "twib",
    episode: 127,
    url: "https://www.youtube.com/watch?v=abcdefghijk",
    reported_by: "chad",
  });
  await createJob(db, input(jobs[0]), "synthetic-owner", now);
  const python = `import sys,json,pathlib,urllib.request
sys.path.insert(0,sys.argv[1]+'/capture-jobs')
import poller
def forbidden(*args,**kwargs): raise AssertionError('REAL_NETWORK_OR_CAPTURE_FORBIDDEN')
urllib.request.OpenerDirector.open=forbidden
urllib.request.urlopen=forbidden
poller.worker.bounded_run=forbidden
poller.worker.Downloader.fetch=forbidden
class Transport:
 def post(self,route,payload):
  print(json.dumps(dict(type='post',route=route,payload=payload)),flush=True)
  reply=json.loads(sys.stdin.readline())
  if reply.get('simulate_loss'): raise OSError('synthetic lost response')
  return reply['response']
class Executor:
 def __init__(self): self.jobs={};self.runs=[]
 def submit(self,request):
  self.jobs.setdefault(request['job_id'],dict(state='queued',attempt=1,code=None))
  return self.status(request['job_id'])
 def status(self,job):return dict(self.jobs[job])
 def retry(self,*args):raise AssertionError('NO_RETRY_FIXTURE')
 def run(self,job):
  self.runs.append(job);self.jobs[job]['state']='succeeded';return self.status(job)
state=pathlib.Path(sys.argv[1])/'private-state';state.mkdir(mode=0o700)
config=dict(enabled=True,state_dir=str(state),worker_state_dir='UNUSED',workspace='UNUSED',origin='https://invalid.test',job_credential_file='UNUSED',show='twib',episode=127,max_bytes=100,max_duration_seconds=60)
executor=Executor();client=poller.Poller(config,transport=Transport(),executor=executor,now=lambda:1700000000)
try:
 assert client.tick()=='delivered'
 assert client.tick()=='empty'
 print(json.dumps(dict(type='create_second')),flush=True)
 assert json.loads(sys.stdin.readline())['created'] is True
 try:client.tick();raise AssertionError('loss required')
 except OSError:pass
 assert client.tick()=='delivered'
 assert client.tick()=='empty'
 claims=[dict(request_id=r[0],claim=json.loads(r[1])) for r in client.db.execute('SELECT request_id,claim FROM claim_history')]
 acks=[dict(delivery_id=r[0],payload=json.loads(r[1]),ack=json.loads(r[2])) for r in client.db.execute('SELECT delivery_id,payload,ack FROM acknowledgements')]
 print(json.dumps(dict(type='done',runs=executor.runs,claims=claims,acks=acks,phase=client.db.execute('SELECT phase FROM exchange').fetchone()[0])),flush=True)
finally:client.close()
`;
  child = spawn("python3", ["-B", "-u", "-c", python, temp], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
  });
  let stderr = "",
    outcome,
    second = false,
    loss = false;
  const exchanges = [];
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Python fixture ${code}: ${stderr}`)),
    );
  });
  finished.catch(() => {}); // Prevent an unhandled rejection if a pipe assertion fails first.
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const message = JSON.parse(line);
      if (message.type === "post") {
        const response =
          message.route === "claim"
            ? await claimJob(db, message.payload, now)
            : await acceptResult(db, message.payload, now);
        if (message.route === "claim" && response.claim)
          assert.ok(
            Object.hasOwn(response.claim, "retry_id"),
            "capture claim must preserve explicit retry_id:null",
          );
        const replay =
          message.route === "claim"
            ? await claimJob(db, message.payload, now + 1)
            : await acceptResult(db, message.payload, now + 1);
        assert.deepEqual(replay, response, "actual server immutable replay");
        exchanges.push({ ...message, response });
        const simulate_loss = second && !loss && message.route === "claim";
        if (simulate_loss) loss = true;
        child.stdin.write(JSON.stringify({ response, simulate_loss }) + "\n");
      } else if (message.type === "create_second") {
        await createJob(db, input(jobs[1]), "synthetic-owner", now + 2);
        second = true;
        child.stdin.write('{"created":true}\n');
      } else if (message.type === "done") outcome = message;
      else assert.fail("unknown pipe message");
    }
    await finished;
  } finally {
    clearTimeout(timeout);
  }
  assert.ok(outcome);
  assert.deepEqual(outcome.runs, jobs);
  assert.equal(outcome.phase, "done");
  assert.equal(outcome.claims.length, 2);
  assert.equal(outcome.acks.length, 4);
  for (const record of outcome.acks) {
    assert.equal(record.ack.delivery_id, record.delivery_id);
    assert.equal(record.ack.state, record.payload.state);
    const row = sqlite
      .prepare(
        "SELECT request_json,response_json FROM capture_job_deliveries WHERE delivery_id=?",
      )
      .get(record.delivery_id);
    assert.deepEqual(JSON.parse(row.request_json), record.payload);
    assert.deepEqual(JSON.parse(row.response_json), record.ack);
  }
  for (const record of outcome.claims) {
    assert.equal(record.claim.lease_id, record.request_id);
    const row = sqlite
      .prepare(
        "SELECT response_json FROM capture_job_claims WHERE request_id=?",
      )
      .get(record.request_id);
    assert.deepEqual(JSON.parse(row.response_json).claim, record.claim);
  }
  assert.deepEqual(
    sqlite
      .prepare("SELECT job_id,state,attempt FROM capture_jobs ORDER BY job_id")
      .all()
      .map((r) => ({ ...r })),
    jobs.map((job_id) => ({ job_id, state: "succeeded", attempt: 1 })),
  );
  const replays = exchanges.filter(
    (e) => e.route === "claim" && e.response.claim?.job_id === jobs[1],
  );
  assert.equal(replays.length, 2);
  assert.deepEqual(replays[0].payload, replays[1].payload);
  assert.equal(
    exchanges.filter((e) => e.route === "claim" && e.response.claim === null)
      .length,
    2,
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) AS n FROM capture_job_deliveries").get().n,
    4,
  );
  console.log(
    "PASS: actual Python poller ↔ actual TypeScript store; two owner jobs, four durable matching acknowledgements, claim/result replay, lost claim response without recapture, two empty polls. Fake executor; no HTTP listener, credentials or media.",
  );
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  sqlite.close();
  await rm(temp, { recursive: true, force: true });
}
