import type { Env } from "../env";
import { HttpError } from "../errors";
import { INVENTORY_SOURCE, sha256 } from "../inventory/contract";
import {
  authorizationTable,
  eligibility,
  readCut,
  planningEnabled,
  executionEnabled,
} from "./cut";
import { cutWireSchema, planWireSchema, proposalSchema } from "./cut-contract";
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
    input.capture ||
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
      AND EXISTS(SELECT 1 FROM ${authorizationTable(cut)} WHERE source_id=? AND episode_id=? AND item_id=? AND revision=? AND status='cut_down' AND reviewed_version=?)`,
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
        "UPDATE capture_jobs SET state=?,attempt=?,code=?,updated_at=? WHERE job_id=? AND lease_id=? AND state=? AND attempt=? AND NOT EXISTS(SELECT 1 FROM inventory_cut_requests WHERE request_id=? AND proposal_json IS NOT NULL) AND EXISTS(SELECT 1 FROM capture_job_deliveries WHERE delivery_id=? AND request_json=?)",
      )
      .bind(
        input.state,
        input.attempt,
        input.code,
        now,
        input.job_id,
        input.lease_id,
        job.state,
        job.attempt,
        input.job_id,
        input.delivery_id,
        wire,
      ),
    db
      .prepare(
        "UPDATE inventory_cut_requests SET state=?,code=?,proposal_json=?,updated_at=? WHERE request_id=? AND proposal_json IS NULL AND EXISTS(SELECT 1 FROM capture_jobs WHERE job_id=? AND lease_id=? AND state=? AND attempt=? AND updated_at=?) AND EXISTS(SELECT 1 FROM capture_job_deliveries WHERE delivery_id=? AND request_json=?)",
      )
      .bind(
        input.state,
        input.code,
        input.proposal ? JSON.stringify(input.proposal) : null,
        now,
        input.job_id,
        input.job_id,
        input.lease_id,
        input.state,
        input.attempt,
        now,
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

// A committed planning receipt must be acknowledged even when a later owner
// decision makes its derived execution ineligible. Preserve that separate outcome.
export async function transitionAfterReceipt(env: Env, id: string) {
  const current = await readCut(env.DB, id);
  if (current?.transition_code) return;
  try {
    await transitionFirstPass(env, id);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    await env.DB.prepare(
      "UPDATE inventory_cut_requests SET transition_code=? WHERE request_id=? AND proposal_json IS NOT NULL AND transition_code IS NULL AND NOT EXISTS(SELECT 1 FROM inventory_cut_requests child WHERE child.source_plan_request_id=?)",
    )
      .bind(error.code, id, id)
      .run();
  }
}

// Internal transition, called only after authenticated plan receipt and BOTH
// operation grants plus all planning/execution/automatic gates. No owner session
// is impersonated, and no review status is approved or revision advanced.
export async function transitionFirstPass(
  env: Env,
  planId: string,
  now = Date.now(),
) {
  if (
    env.CUT_FIRST_PASS_AUTO_ENABLED !== "true" ||
    !planningEnabled(env) ||
    !executionEnabled(env)
  )
    return null;
  const db = env.DB;
  const cut = await readCut(db, planId);
  if (!cut || !cut.proposal_json) throw conflict();
  const original = cutWireSchema.parse(JSON.parse(cut.request_json));
  if (original.spec.kind !== "first_pass") return null;
  if (original.intake_work_id && env.INTAKE_WORK_REQUESTS_ENABLED !== "true")
    return null;
  const proposal = proposalSchema.parse(JSON.parse(cut.proposal_json));
  if (
    proposal.requestRevision !== (await sha256(cut.request_json)) ||
    proposal.sourceSha256 !== original.parent.sha256 ||
    proposal.range.kind !== "range"
  )
    throw conflict();
  const hash = await sha256(
    "first-pass-derivative/v1:" + planId + ":" + proposal.binding,
  );
  const id =
    hash.slice(0, 8) +
    "-" +
    hash.slice(8, 12) +
    "-4" +
    hash.slice(13, 16) +
    "-8" +
    hash.slice(17, 20) +
    "-" +
    hash.slice(20, 32);
  const request = JSON.stringify(
    cutWireSchema.parse({
      ...original,
      job_id: id,
      spec: proposal.range,
      editorial: {
        planJobId: planId,
        binding: proposal.binding,
        contextRevision: proposal.contextRevision,
        requestRevision: proposal.requestRevision,
      },
    }),
  );
  const previous = await readCut(db, id);
  if (previous) {
    if (
      previous.source_plan_request_id !== planId ||
      previous.request_json !== request
    )
      throw conflict();
    return { requestId: id, sourcePlanRequestId: planId };
  }
  const { episode, obs, duplicateId } = await eligibility(db, cut);
  const guard = `EXISTS(SELECT 1 FROM inventory_cut_requests WHERE request_id=? AND request_json=? AND proposal_json=?)
    AND EXISTS(SELECT 1 FROM inventory_observations o WHERE source_id=? AND episode_id=? AND item_id=? AND receipt_id=? AND sequence=? AND NOT EXISTS(SELECT 1 FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id AND n.sequence>o.sequence))
    AND EXISTS(SELECT 1 FROM ${authorizationTable(cut)} WHERE source_id=? AND episode_id=? AND item_id=? AND revision=? AND status='cut_down' AND reviewed_version=?)
    AND NOT EXISTS(SELECT 1 FROM inventory_observations d WHERE d.source_id=? AND d.episode_id=? AND d.item_id<>? AND coalesce(json_extract(d.item_json,'$.producer_record.clip_uid'),json_extract(d.item_json,'$.producer_record.clip_id'))=? AND json_extract(d.item_json,'$.media.present')=1 AND d.sequence=(SELECT max(n.sequence) FROM inventory_observations n WHERE n.source_id=d.source_id AND n.episode_id=d.episode_id AND n.item_id=d.item_id))`;
  const bindings = [
    planId,
    cut.request_json,
    cut.proposal_json,
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
    INVENTORY_SOURCE,
    episode,
    cut.item_id,
    duplicateId,
  ];
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO inventory_cut_requests(request_id,item_id,owner,parent_version,review_revision,request_json,state,source_plan_request_id,created_at,updated_at) SELECT ?,?,?,?,?,?,'queued',?,?,? WHERE ${guard}`,
      )
      .bind(
        id,
        cut.item_id,
        cut.owner,
        cut.parent_version,
        cut.review_revision,
        request,
        planId,
        now,
        now,
        ...bindings,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO capture_jobs(job_id,request_json,owner,state,operation,created_at,updated_at) SELECT ?,?,?,'queued','capture',?,? WHERE EXISTS(SELECT 1 FROM inventory_cut_requests WHERE request_id=? AND source_plan_request_id=? AND request_json=?) AND ${guard}`,
      )
      .bind(id, request, cut.owner, now, now, id, planId, request, ...bindings),
  ]);
  const saved = await readCut(db, id);
  if (
    !saved ||
    saved.source_plan_request_id !== planId ||
    saved.request_json !== request ||
    saved.exec_state !== "queued"
  )
    throw conflict();
  return { requestId: id, sourcePlanRequestId: planId };
}
