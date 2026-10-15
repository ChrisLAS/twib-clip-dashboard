import { sha256 } from "../inventory/contract";
import { kindGranted } from "./scope";
import {
  cutSpecSchema,
  cutWireSchema,
  derivativeSchema,
  planWireSchema,
  proposalSchema,
} from "./cut-contract";
export { cutSpecSchema } from "./cut-contract";
import type { InventoryItem } from "../inventory/contract";
import { INVENTORY_SOURCE, inventoryEpisodeId } from "../inventory/contract";
import { inventoryVersion, reviewFor } from "../inventory/review";
import { HttpError } from "../errors";
import type { Env } from "../env";
import { retryJob } from "./store";
export function cutsEnabled(env: Env) {
  return env.CUT_REQUESTS_ENABLED === "true";
}
export function planningEnabled(env: Env) {
  return (
    cutsEnabled(env) &&
    env.CAPTURE_JOBS_ENABLED === "true" &&
    env.CUT_PLANNING_ENABLED === "true" &&
    kindGranted(env, "plan")
  );
}
export function executionEnabled(env: Env) {
  return (
    kindGranted(env, "cut") &&
    cutsEnabled(env) &&
    env.CUT_JOBS_ENABLED === "true" &&
    env.CAPTURE_JOBS_ENABLED === "true"
  );
}
const denied = () =>
  new HttpError(
    409,
    "CUT_REQUEST_CONFLICT",
    "The request or source changed. Refresh before submitting; no cut was started.",
  );
export function preparedCut(
  input: {
    operationId: string;
    expectedVersion: string;
    expectedRevision: number;
    cutSpec?: unknown;
  },
  item: InventoryItem,
  owner: string,
  now: number,
) {
  if (input.cutSpec === undefined) return null;
  const spec = cutSpecSchema.parse(input.cutSpec);
  if (
    item.kind !== "media" ||
    !item.media?.present ||
    item.media.size_bytes == null
  )
    throw denied();
  if (
    spec.kind === "range" &&
    item.media.duration_seconds != null &&
    spec.endSeconds > item.media.duration_seconds
  )
    throw new HttpError(
      422,
      "CUT_RANGE_INVALID",
      "The requested end exceeds the observed duration.",
    );
  const hashes = [
    ...new Set(
      (item.capture_evidence ?? [])
        .map((e) => e.producer_sha256)
        .filter(Boolean),
    ),
  ];
  const wire = cutWireSchema.parse({
    job_id: input.operationId,
    kind: "cut",
    show: "twib",
    episode: 127,
    reported_by: "chad",
    parent: {
      item_id: item.id,
      clip_id: item.producer_record?.clip_id ?? null,
      clip_uid: item.producer_record?.clip_uid ?? null,
      ref: item.media.ref,
      sha256: hashes.length === 1 ? hashes[0] : null,
      size_bytes: item.media.size_bytes,
      modified_at: item.media.modified_at,
    },
    spec,
  });
  return {
    id: input.operationId,
    itemId: item.id,
    owner,
    version: input.expectedVersion,
    revision: input.expectedRevision + 1,
    wire: JSON.stringify(wire),
    state: spec.kind === "range" ? "requested" : "needs_review",
    now,
  };
}
export function cutInsert(
  db: D1Database,
  p: NonNullable<ReturnType<typeof preparedCut>>,
  requestHash: string,
  response: string,
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO inventory_cut_requests(request_id,item_id,owner,parent_version,review_revision,request_json,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM inventory_review_operations WHERE operation_id=? AND owner=? AND request_hash=? AND response_json=?)`,
    )
    .bind(
      p.id,
      p.itemId,
      p.owner,
      p.version,
      p.revision,
      p.wire,
      p.state,
      p.now,
      p.now,
      p.id,
      p.owner,
      requestHash,
      response,
    );
}
type Row = {
  request_id: string;
  item_id: string;
  owner: string;
  parent_version: string;
  review_revision: number;
  request_json: string;
  state: string;
  derivative_json: string | null;
  code: string | null;
  proposal_json?: string | null;
  source_plan_request_id?: string | null;
  exec_state?: string | null;
  exec_code?: string | null;
};
export function cutView(row: Row) {
  const wire = cutWireSchema.parse(JSON.parse(row.request_json));
  return {
    requestId: row.request_id,
    sourcePlanRequestId: row.source_plan_request_id ?? null,
    parentItemId: row.item_id,
    parentVersion: row.parent_version,
    reviewRevision: row.review_revision,
    state:
      row.derivative_json || row.state === "failed"
        ? row.state
        : (row.exec_state ?? row.state),
    // Revisions appear only after an authenticated proposal receipt.
    code:
      row.exec_code ??
      row.code ??
      (!row.exec_state && wire.spec.kind === "first_pass"
        ? "CONTEXT_MISSING"
        : null),
    contextRevision: row.proposal_json
      ? proposalSchema.parse(JSON.parse(row.proposal_json)).contextRevision
      : null,
    proposal: row.proposal_json
      ? proposalSchema.parse(JSON.parse(row.proposal_json))
      : null,
    spec: wire.spec,
    parent: wire.parent,
    derivative: row.derivative_json
      ? derivativeSchema.parse(JSON.parse(row.derivative_json))
      : null,
  };
}
export async function readCut(db: D1Database, id: string) {
  return db
    .prepare(
      "SELECT c.*,j.state exec_state,j.code exec_code FROM inventory_cut_requests c LEFT JOIN capture_jobs j ON j.job_id=c.request_id WHERE c.request_id=?",
    )
    .bind(id)
    .first<Row>();
}
export async function eligibility(db: D1Database, row: Row) {
  const episode = await inventoryEpisodeId(127);
  const obs = await db
    .prepare(
      "SELECT receipt_id,sequence,item_json FROM inventory_observations WHERE source_id=? AND episode_id=? AND item_id=? ORDER BY sequence DESC LIMIT 1",
    )
    .bind(INVENTORY_SOURCE, episode, row.item_id)
    .first<{ receipt_id: string; sequence: number; item_json: string }>();
  if (!obs) throw denied();
  const item = JSON.parse(obs.item_json) as InventoryItem;
  const review = await reviewFor(db, episode, item);
  if (
    (await inventoryVersion(item)) !== row.parent_version ||
    review?.revision !== row.review_revision ||
    review.status !== "cut_down" ||
    review.reviewed_version !== row.parent_version
  )
    throw denied();
  const duplicateId =
    item.producer_record?.clip_uid ?? item.producer_record?.clip_id ?? null;
  return { episode, obs, duplicateId };
}
export async function enqueueCut(
  db: D1Database,
  id: string,
  owner: string,
  now = Date.now(),
  planning = false,
) {
  const row = await readCut(db, id);
  if (!row || row.owner !== owner) throw denied();
  if (
    row.state !== "requested" &&
    !(planning && row.state === "needs_review" && !row.exec_state)
  )
    return cutView(row);
  const wire = cutWireSchema.parse(JSON.parse(row.request_json));
  if ((wire.spec.kind !== "range") !== planning) throw denied();
  const queuedWire = planning
    ? JSON.stringify(
        planWireSchema.parse({
          ...wire,
          kind: "plan",
          planning: {
            parentVersion: row.parent_version,
            reviewRevision: row.review_revision,
            requestRevision: await sha256(row.request_json),
          },
        }),
      )
    : row.request_json;
  if (!wire.parent.sha256)
    throw new HttpError(
      409,
      "CUT_SOURCE_PROOF_REQUIRED",
      "A current source hash is required before a cut can execute. Instructions remain saved.",
    );
  const { episode, obs, duplicateId } = await eligibility(db, row);
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO capture_jobs(job_id,request_json,owner,state,operation,created_at,updated_at) SELECT ?,?,?,'queued','capture',?,? WHERE EXISTS(SELECT 1 FROM inventory_observations o WHERE o.source_id=? AND o.episode_id=? AND o.item_id=? AND o.receipt_id=? AND o.sequence=? AND NOT EXISTS(SELECT 1 FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id AND n.sequence>o.sequence)) AND EXISTS(SELECT 1 FROM inventory_reviews WHERE source_id=? AND episode_id=? AND item_id=? AND revision=? AND status='cut_down' AND reviewed_version=?) AND NOT EXISTS(SELECT 1 FROM inventory_observations d WHERE d.source_id=? AND d.episode_id=? AND d.item_id<>? AND coalesce(json_extract(d.item_json,'$.producer_record.clip_uid'),json_extract(d.item_json,'$.producer_record.clip_id'))=? AND json_extract(d.item_json,'$.media.present')=1 AND d.sequence=(SELECT max(n.sequence) FROM inventory_observations n WHERE n.source_id=d.source_id AND n.episode_id=d.episode_id AND n.item_id=d.item_id))`,
      )
      .bind(
        id,
        queuedWire,
        owner,
        now,
        now,
        INVENTORY_SOURCE,
        episode,
        row.item_id,
        obs.receipt_id,
        obs.sequence,
        INVENTORY_SOURCE,
        episode,
        row.item_id,
        row.review_revision,
        row.parent_version,
        INVENTORY_SOURCE,
        episode,
        row.item_id,
        duplicateId,
      ),
    db
      .prepare(
        "UPDATE inventory_cut_requests SET state='queued',updated_at=? WHERE request_id=? AND state IN ('requested','needs_review') AND EXISTS(SELECT 1 FROM capture_jobs WHERE job_id=? AND request_json=? AND owner=?)",
      )
      .bind(now, id, id, queuedWire, owner),
  ]);
  const next = await readCut(db, id);
  if (!next || next.state !== "queued") throw denied();
  return cutView(next);
}
export async function retryCut(
  db: D1Database,
  id: string,
  value: unknown,
  owner: string,
  now = Date.now(),
) {
  const row = await readCut(db, id);
  if (!row || row.owner !== owner || row.derivative_json) throw denied();
  const wire = cutWireSchema.parse(JSON.parse(row.request_json));
  if (wire.spec.kind !== "range" || !wire.parent.sha256) throw denied();
  const { episode, obs, duplicateId } = await eligibility(db, row);
  await retryJob(db, id, value, now, {
    sql: `NOT EXISTS(SELECT 1 FROM inventory_cut_requests c WHERE c.request_id=? AND c.derivative_json IS NOT NULL) AND EXISTS(SELECT 1 FROM inventory_observations o WHERE o.source_id=? AND o.episode_id=? AND o.item_id=? AND o.receipt_id=? AND o.sequence=? AND NOT EXISTS(SELECT 1 FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id AND n.sequence>o.sequence)) AND EXISTS(SELECT 1 FROM inventory_reviews WHERE source_id=? AND episode_id=? AND item_id=? AND revision=? AND status='cut_down' AND reviewed_version=?) AND NOT EXISTS(SELECT 1 FROM inventory_observations d WHERE d.source_id=? AND d.episode_id=? AND d.item_id<>? AND coalesce(json_extract(d.item_json,'$.producer_record.clip_uid'),json_extract(d.item_json,'$.producer_record.clip_id'))=? AND json_extract(d.item_json,'$.media.present')=1 AND d.sequence=(SELECT max(n.sequence) FROM inventory_observations n WHERE n.source_id=d.source_id AND n.episode_id=d.episode_id AND n.item_id=d.item_id))`,
    bindings: [
      id,
      INVENTORY_SOURCE,
      episode,
      row.item_id,
      obs.receipt_id,
      obs.sequence,
      INVENTORY_SOURCE,
      episode,
      row.item_id,
      row.review_revision,
      row.parent_version,
      INVENTORY_SOURCE,
      episode,
      row.item_id,
      duplicateId,
    ],
  });
  await db
    .prepare(
      "UPDATE inventory_cut_requests SET state='queued',code=NULL,updated_at=? WHERE request_id=? AND EXISTS(SELECT 1 FROM capture_jobs WHERE job_id=? AND state='queued')",
    )
    .bind(now, id, id)
    .run();
  return cutView((await readCut(db, id))!);
}
export async function attachCuts(db: D1Database, items: { id: string }[]) {
  if (!items.length) return [];
  return (
    await db
      .prepare(
        `SELECT c.*,j.state exec_state,j.code exec_code FROM inventory_cut_requests c LEFT JOIN capture_jobs j ON j.job_id=c.request_id WHERE c.item_id IN (${items.map(() => "?").join(",")}) ORDER BY c.created_at DESC,c.request_id LIMIT 100`,
      )
      .bind(...items.map((i) => i.id))
      .all<Row>()
  ).results.map(cutView);
}
