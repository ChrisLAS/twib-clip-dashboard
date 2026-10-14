import { cutWireSchema, derivativeSchema } from "./cut-contract";
import { HttpError } from "../errors";
import {
  createJobSchema,
  claimSchema,
  resultSchema,
  retrySchema,
  type ClaimResponse,
} from "./contract";
type Row = {
  job_id: string;
  request_json: string;
  state: string;
  operation: "capture" | "retry";
  retry_id: string | null;
  lease_id: string | null;
  lease_expires_at: number | null;
  attempt: number;
};
const conflict = () =>
  new HttpError(
    409,
    "JOB_CONFLICT",
    "Reconcile the existing job before retrying.",
  );
const read = (db: D1Database, id: string) =>
  db.prepare("SELECT * FROM capture_jobs WHERE job_id=?").bind(id).first<Row>();
async function capacity(
  db: D1Database,
  table: "capture_jobs" | "capture_job_claims" | "capture_job_deliveries",
  limit: number,
) {
  const count = await db
    .prepare(`SELECT count(*) AS n FROM ${table}`)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= limit)
    throw new HttpError(
      429,
      "JOB_CAPACITY",
      "Capture transport capacity requires operator review.",
    );
}
export async function createJob(
  db: D1Database,
  value: unknown,
  owner: string,
  now = Date.now(),
) {
  const input = createJobSchema.parse(value),
    wire = JSON.stringify(input);
  if (!(await read(db, input.job_id))) await capacity(db, "capture_jobs", 1000);
  await db
    .prepare(
      "INSERT OR IGNORE INTO capture_jobs(job_id,request_json,owner,state,operation,created_at,updated_at) VALUES(?,?,?,'queued','capture',?,?)",
    )
    .bind(input.job_id, wire, owner, now, now)
    .run();
  const row = await read(db, input.job_id);
  if (row?.request_json !== wire) throw conflict();
  return { version: 1, job_id: input.job_id, state: row.state };
}
export async function listJobs(db: D1Database) {
  return {
    version: 1,
    jobs: (
      await db
        .prepare(
          "SELECT job_id,request_json,state,operation,retry_id,attempt,code,created_at,updated_at FROM capture_jobs ORDER BY created_at DESC,job_id LIMIT 100",
        )
        .all()
    ).results,
  };
}
export async function retryJob(
  db: D1Database,
  id: string,
  value: unknown,
  now = Date.now(),
  eligibility?: { sql: string; bindings: (string | number | null)[] },
) {
  const current = await read(db, id);
  if (
    current &&
    JSON.parse(current.request_json).kind === "cut" &&
    !eligibility
  )
    throw conflict();
  const input = retrySchema.parse(value),
    wire = JSON.stringify({ job_id: id, ...input });
  const old = await db
    .prepare("SELECT request_json FROM capture_job_retries WHERE retry_id=?")
    .bind(input.retry_id)
    .first<{ request_json: string }>();
  if (old) {
    if (old.request_json !== wire) throw conflict();
    return { version: 1, job_id: id, retry_id: input.retry_id };
  }
  await db.batch([
    db
      .prepare(
        "UPDATE capture_jobs SET state='needs_review',code='LEASE_EXPIRED',updated_at=? WHERE job_id=? AND lease_expires_at<=? AND state IN ('running','waiting_for_episode','blocked')",
      )
      .bind(now, id, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO capture_job_retries(retry_id,job_id,request_json) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM capture_jobs WHERE job_id=? AND state='needs_review' AND attempt<100)${eligibility ? " AND (" + eligibility.sql + ")" : ""}`,
      )
      .bind(input.retry_id, id, wire, id, ...(eligibility?.bindings ?? [])),
    db
      .prepare(
        `UPDATE capture_jobs SET state='queued',operation='retry',retry_id=?,lease_id=NULL,lease_expires_at=NULL,code=NULL,updated_at=? WHERE job_id=? AND state='needs_review' AND EXISTS(SELECT 1 FROM capture_job_retries WHERE retry_id=? AND job_id=?)${eligibility ? " AND (" + eligibility.sql + ")" : ""}`,
      )
      .bind(
        input.retry_id,
        now,
        id,
        input.retry_id,
        id,
        ...(eligibility?.bindings ?? []),
      ),
  ]);
  const saved = await db
    .prepare("SELECT request_json FROM capture_job_retries WHERE retry_id=?")
    .bind(input.retry_id)
    .first<{ request_json: string }>();
  if (saved?.request_json !== wire) throw conflict();
  return { version: 1, job_id: id, retry_id: input.retry_id };
}
export async function claimJob(
  db: D1Database,
  value: unknown,
  now = Date.now(),
): Promise<ClaimResponse> {
  const { request_id, job_kind = "capture" } = claimSchema.parse(value);
  const responseFor = (encoded: string): ClaimResponse => {
    const stored = JSON.parse(encoded) as ClaimResponse & {
      _job_kind?: string;
    };
    if ((stored._job_kind ?? "capture") !== job_kind) throw conflict();
    const { _job_kind: ignored, ...response } = stored;
    void ignored;
    return response;
  };
  const old = await db
    .prepare("SELECT response_json FROM capture_job_claims WHERE request_id=?")
    .bind(request_id)
    .first<{ response_json: string }>();
  if (old) return responseFor(old.response_json);
  try {
    await capacity(db, "capture_job_claims", 10000);
  } catch (error) {
    const replay = await db
      .prepare(
        "SELECT response_json FROM capture_job_claims WHERE request_id=?",
      )
      .bind(request_id)
      .first<{ response_json: string }>();
    if (replay) return responseFor(replay.response_json);
    throw error;
  }
  // Claim UUID is also the lease UUID: replay lookup remains stable after response loss.
  await db.batch([
    db
      .prepare(
        "UPDATE capture_jobs SET state='needs_review',code='LEASE_EXPIRED',updated_at=? WHERE lease_expires_at<=? AND state IN ('running','waiting_for_episode','blocked') AND coalesce(json_extract(request_json,'$.kind'),'capture')=?",
      )
      .bind(now, now, job_kind),
    db
      .prepare(
        "UPDATE capture_jobs SET state='running',lease_id=?,lease_expires_at=?,updated_at=? WHERE job_id=(SELECT job_id FROM capture_jobs WHERE state='queued' AND coalesce(json_extract(request_json,'$.kind'),'capture')=? ORDER BY created_at,job_id LIMIT 1) AND state='queued' AND NOT EXISTS(SELECT 1 FROM capture_job_claims WHERE request_id=?) AND NOT EXISTS(SELECT 1 FROM capture_jobs WHERE lease_id=?)",
      )
      .bind(request_id, now + 7200000, now, job_kind, request_id, request_id),
    db
      .prepare(
        `INSERT OR IGNORE INTO capture_job_claims(request_id,response_json)
      SELECT ?, json_object('_job_kind',?,'version',1,'claim',json(COALESCE(
        (SELECT json_set(request_json,'$.operation',operation,'$.retry_id',retry_id,
          '$.lease_id',lease_id,'$.lease_expires_at',?, '$.executor','nomad:capture-worker')
         FROM capture_jobs WHERE lease_id=? AND coalesce(json_extract(request_json,'$.kind'),'capture')=?), 'null')))`,
      )
      .bind(
        request_id,
        job_kind,
        new Date(now + 7200000).toISOString(),
        request_id,
        job_kind,
      ),
  ]);
  const saved = await db
    .prepare("SELECT response_json FROM capture_job_claims WHERE request_id=?")
    .bind(request_id)
    .first<{ response_json: string }>();
  return responseFor(saved!.response_json);
}
export async function acceptResult(
  db: D1Database,
  value: unknown,
  now = Date.now(),
) {
  const input = resultSchema.parse(value),
    wire = JSON.stringify(input);
  const old = await db
    .prepare(
      "SELECT request_json,response_json FROM capture_job_deliveries WHERE delivery_id=?",
    )
    .bind(input.delivery_id)
    .first<{ request_json: string; response_json: string }>();
  if (old) {
    if (old.request_json !== wire) throw conflict();
    return JSON.parse(old.response_json) as unknown;
  }
  const replay = async () => {
    const saved = await db
      .prepare(
        "SELECT request_json,response_json FROM capture_job_deliveries WHERE delivery_id=?",
      )
      .bind(input.delivery_id)
      .first<{ request_json: string; response_json: string }>();
    if (saved && saved.request_json !== wire) throw conflict();
    return saved;
  };
  try {
    await capacity(db, "capture_job_deliveries", 50000);
  } catch (error) {
    const saved = await replay();
    if (saved) return JSON.parse(saved.response_json) as unknown;
    throw error;
  }
  const row = await read(db, input.job_id);
  if (
    !row ||
    row.lease_id !== input.lease_id ||
    row.state === "queued" ||
    row.state === "succeeded" ||
    input.attempt < row.attempt ||
    (row.state === "needs_review" &&
      !["needs_review", "succeeded"].includes(input.state)) ||
    ((row.state === "needs_review" || (row.lease_expires_at ?? 0) <= now) &&
      input.state === "running")
  ) {
    // An identical delivery may have committed between the first receipt read
    // and this state read. Return its durable ack instead of a false conflict.
    const saved = await replay();
    if (saved) return JSON.parse(saved.response_json) as unknown;
    throw conflict();
  }
  const isCut = JSON.parse(row.request_json).kind === "cut";
  let derivative: ReturnType<typeof derivativeSchema.parse> | null = null;
  if (isCut) {
    const finished = await db
      .prepare(
        "SELECT derivative_json FROM inventory_cut_requests WHERE request_id=?",
      )
      .bind(input.job_id)
      .first<{ derivative_json: string | null }>();
    if (finished?.derivative_json) throw conflict();
    const request = cutWireSchema.parse(JSON.parse(row.request_json));
    if (input.state === "succeeded") throw conflict();
    if (input.result) {
      derivative = derivativeSchema.parse(input.result);
      if (
        input.state !== "needs_review" ||
        input.code !== "CUT_READY_FOR_REVIEW" ||
        request.spec.kind !== "range" ||
        derivative.clip_id !== `${input.job_id}-a${input.attempt}` ||
        derivative.ref !== `new-review/${derivative.clip_id}.mp4` ||
        derivative.source_sha256 !== request.parent.sha256 ||
        (request.parent.clip_id &&
          derivative.parent_clip_id !== request.parent.clip_id) ||
        derivative.local_in_seconds !== request.spec.startSeconds ||
        derivative.local_out_seconds !== request.spec.endSeconds ||
        Math.abs(
          derivative.duration_seconds -
            (request.spec.endSeconds - request.spec.startSeconds),
        ) > 0.15
      )
        throw conflict();
    } else if (input.code === "CUT_READY_FOR_REVIEW") throw conflict();
  } else if (input.result) throw conflict();
  const response = {
    version: 1,
    delivery_id: input.delivery_id,
    job_id: input.job_id,
    accepted: true,
    state: input.state,
  };
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO capture_job_deliveries(delivery_id,request_json,response_json) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM capture_jobs WHERE job_id=? AND lease_id=? AND state=? AND attempt=?)${isCut ? " AND NOT EXISTS(SELECT 1 FROM inventory_cut_requests WHERE request_id=? AND derivative_json IS NOT NULL)" : ""}`,
      )
      .bind(
        input.delivery_id,
        wire,
        JSON.stringify(response),
        input.job_id,
        input.lease_id,
        row.state,
        row.attempt,
        ...(isCut ? [input.job_id] : []),
      ),
    db
      .prepare(
        `UPDATE capture_jobs SET state=?,attempt=?,code=?,updated_at=? WHERE job_id=? AND lease_id=? AND state=? AND attempt=? AND EXISTS(SELECT 1 FROM capture_job_deliveries WHERE delivery_id=? AND request_json=?)${isCut ? " AND NOT EXISTS(SELECT 1 FROM inventory_cut_requests WHERE request_id=? AND derivative_json IS NOT NULL)" : ""}`,
      )
      .bind(
        input.state,
        input.attempt,
        input.code,
        now,
        input.job_id,
        input.lease_id,
        row.state,
        row.attempt,
        input.delivery_id,
        wire,
        ...(isCut ? [input.job_id] : []),
      ),
    ...(isCut
      ? [
          db
            .prepare(
              "UPDATE inventory_cut_requests SET state=?,code=?,derivative_json=?,updated_at=? WHERE request_id=? AND derivative_json IS NULL AND EXISTS(SELECT 1 FROM capture_job_deliveries WHERE delivery_id=? AND request_json=?)",
            )
            .bind(
              input.state === "needs_review"
                ? derivative
                  ? "needs_review"
                  : input.code?.startsWith("CUT_FAILED")
                    ? "failed"
                    : "needs_review"
                : input.state,
              input.code,
              derivative ? JSON.stringify(derivative) : null,
              now,
              input.job_id,
              input.delivery_id,
              wire,
            ),
        ]
      : []),
  ]);
  const saved = await db
    .prepare(
      "SELECT request_json,response_json FROM capture_job_deliveries WHERE delivery_id=?",
    )
    .bind(input.delivery_id)
    .first<{ request_json: string; response_json: string }>();
  if (saved?.request_json !== wire) throw conflict();
  return JSON.parse(saved.response_json) as unknown;
}
