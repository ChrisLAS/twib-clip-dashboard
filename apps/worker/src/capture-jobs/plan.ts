import { HttpError } from "../errors";
import { INVENTORY_SOURCE, sha256 } from "../inventory/contract";
import { eligibility, readCut } from "./cut";
import { planWireSchema, proposalSchema } from "./cut-contract";
import { resultSchema } from "./contract";

const conflict = () =>
  new HttpError(
    409,
    "PLAN_CONFLICT",
    "The planning request or source changed. Refresh before continuing.",
  );
// Only an owner can obtain a currently eligible range. This never approves or executes it.
export async function proposalRange(db: D1Database, id: string, owner: string) {
  const cut = await readCut(db, id);
  if (!cut || cut.owner !== owner || !cut.proposal_json) throw conflict();
  await eligibility(db, cut);
  const proposal = proposalSchema.parse(JSON.parse(cut.proposal_json));
  if (proposal.requestRevision !== (await sha256(cut.request_json)))
    throw conflict();
  return {
    requestId: id,
    parentVersion: cut.parent_version,
    reviewRevision: cut.review_revision,
    proposal,
  };
}
export async function acceptPlanResult(
  db: D1Database,
  value: unknown,
  now: number,
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
  const job = await db
    .prepare("SELECT * FROM capture_jobs WHERE job_id=?")
    .bind(input.job_id)
    .first<{
      request_json: string;
      lease_id: string;
      lease_expires_at: number;
      state: string;
      attempt: number;
    }>();
  const cut = await readCut(db, input.job_id);
  if (
    !job ||
    !cut ||
    cut.proposal_json ||
    job.lease_id !== input.lease_id ||
    job.lease_expires_at <= now ||
    !["running", "blocked", "waiting_for_episode"].includes(job.state) ||
    input.attempt < job.attempt ||
    input.result ||
    input.state === "succeeded"
  )
    throw conflict();
  const request = planWireSchema.parse(JSON.parse(job.request_json));
  if (
    request.planning.requestRevision !== (await sha256(cut.request_json)) ||
    request.planning.parentVersion !== cut.parent_version ||
    request.planning.reviewRevision !== cut.review_revision
  )
    throw conflict();
  const { episode, obs } = await eligibility(db, cut);
  if (input.proposal) {
    if (
      input.state !== "needs_review" ||
      input.code !== "EDITORIAL_PROPOSAL_READY" ||
      input.proposal.sourceSha256 !== request.parent.sha256 ||
      input.proposal.requestRevision !== request.planning.requestRevision
    )
      throw conflict();
    const item = JSON.parse(obs.item_json);
    if (
      input.proposal.range.kind !== "range" ||
      (item.media?.duration_seconds != null &&
        input.proposal.range.endSeconds > item.media.duration_seconds)
    )
      throw conflict();
  } else if (input.code === "EDITORIAL_PROPOSAL_READY") throw conflict();
  const response = {
    version: 1,
    delivery_id: input.delivery_id,
    job_id: input.job_id,
    accepted: true,
    state: input.state,
  };
  // Receipt, job state, and proposal are committed in one transaction. The receipt
  // predicate rechecks the exact observation and decision used above.
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO capture_job_deliveries(delivery_id,request_json,response_json)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM capture_jobs WHERE job_id=? AND lease_id=? AND state=? AND attempt=? AND lease_expires_at>?)
      AND EXISTS(SELECT 1 FROM inventory_cut_requests WHERE request_id=? AND proposal_json IS NULL)
      AND EXISTS(SELECT 1 FROM inventory_observations o WHERE source_id=? AND episode_id=? AND item_id=? AND receipt_id=? AND sequence=? AND NOT EXISTS(SELECT 1 FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id AND n.sequence>o.sequence))
      AND EXISTS(SELECT 1 FROM inventory_reviews WHERE source_id=? AND episode_id=? AND item_id=? AND revision=? AND status='cut_down' AND reviewed_version=?)`,
      )
      .bind(
        input.delivery_id,
        wire,
        JSON.stringify(response),
        input.job_id,
        input.lease_id,
        job.state,
        job.attempt,
        now,
        input.job_id,
        INVENTORY_SOURCE,
        episode,
        cut.item_id,
        obs.receipt_id,
        obs.sequence,
        INVENTORY_SOURCE,
        episode,
        cut.item_id,
        cut.review_revision,
        cut.parent_version,
      ),
    db
      .prepare(
        "UPDATE capture_jobs SET state=?,attempt=?,code=?,updated_at=? WHERE job_id=? AND EXISTS(SELECT 1 FROM capture_job_deliveries WHERE delivery_id=? AND request_json=?)",
      )
      .bind(
        input.state,
        input.attempt,
        input.code,
        now,
        input.job_id,
        input.delivery_id,
        wire,
      ),
    db
      .prepare(
        "UPDATE inventory_cut_requests SET state=?,code=?,proposal_json=?,updated_at=? WHERE request_id=? AND proposal_json IS NULL AND EXISTS(SELECT 1 FROM capture_job_deliveries WHERE delivery_id=? AND request_json=?)",
      )
      .bind(
        input.state,
        input.code,
        input.proposal ? JSON.stringify(input.proposal) : null,
        now,
        input.job_id,
        input.delivery_id,
        wire,
      ),
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
