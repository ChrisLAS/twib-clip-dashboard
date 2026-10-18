import { z } from "zod";
import type { Env } from "../env";
import type { ManualIntake, IntakeWorkView } from "@twib/shared";
import { HttpError } from "../errors";
import {
  sha256,
  inventoryEpisodeId,
  INVENTORY_SOURCE,
  type InventoryItem,
} from "../inventory/contract";
import { inventoryVersion } from "../inventory/review";
import { createJobSchema, captureReceiptSchema } from "./contract";
import {
  cutSpecSchema,
  cutWireSchema,
  executableCutParentSchema,
} from "./cut-contract";
import {
  cutView,
  readCut,
  enqueueCut,
  planningEnabled,
  executionEnabled,
  retryCut,
  eligibility,
  authorizationTable,
} from "./cut";
import { kindGranted } from "./scope";
import { retryJob } from "./store";
import { intakeCurrentSql } from "./intake-work-guard";

export const intakeWorkEnabled = (env: Env) =>
  env.INTAKE_WORK_REQUESTS_ENABLED === "true";
export const intakeDispatchEnabled = (env: Env) =>
  intakeWorkEnabled(env) &&
  env.CAPTURE_JOBS_ENABLED === "true" &&
  kindGranted(env, "capture") &&
  /^[1-9][0-9]{0,5}$/.test(env.CAPTURE_JOBS_GRANT_EPISODE ?? "");
const conflict = () =>
  new HttpError(
    409,
    "INTAKE_WORK_CONFLICT",
    "The submission or episode changed. Refresh before requesting more work.",
  );
const unavailable = () =>
  new HttpError(
    503,
    "INTAKE_WORK_DISABLED",
    "Link work requests are not activated.",
  );
const inputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    priority: z.enum(["normal", "urgent"]),
  })
  .strict();
type Work = {
  job_id: string;
  owner: string;
  intake_id: string;
  intake_revision: number;
  episode_id: string;
  episode_number: number;
  workspace_revision: number;
  priority: "normal" | "urgent";
  spec_json: string;
  created_at: number;
  inventory_episode_id: string;
  cut_request_id: string | null;
  code: string | null;
};
async function uuid(seed: string) {
  const h = await sha256(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const get = (db: D1Database, id: string, owner: string) =>
  db
    .prepare("SELECT * FROM intake_work_requests WHERE job_id=? AND owner=?")
    .bind(id, owner)
    .first<Work>();
async function current(db: D1Database, w: Work) {
  return !!(await db
    .prepare(
      `SELECT 1 FROM intake_work_requests w WHERE w.job_id=? AND ${intakeCurrentSql}`,
    )
    .bind(w.job_id)
    .first());
}
export async function workView(env: Env, w: Work): Promise<IntakeWorkView> {
  const j = await env.DB.prepare(
    "SELECT state,code,attempt,updated_at FROM capture_jobs WHERE job_id=?",
  )
    .bind(w.job_id)
    .first<{
      state: string;
      code: string | null;
      attempt: number;
      updated_at: number;
    }>();
  if (!j) throw conflict();
  const stale = !(await current(env.DB, w));
  const cut = w.cut_request_id ? await readCut(env.DB, w.cut_request_id) : null;
  const child = cut
    ? await env.DB.prepare(
        "SELECT request_id FROM inventory_cut_requests WHERE source_plan_request_id=?",
      )
        .bind(cut.request_id)
        .first<{ request_id: string }>()
    : null;
  const latest = child ? await readCut(env.DB, child.request_id) : cut;
  const cv = latest ? cutView(latest) : null;
  const downstream = latest
    ? await env.DB.prepare(
        "SELECT state,code,attempt,updated_at FROM capture_jobs WHERE job_id=?",
      )
        .bind(latest.request_id)
        .first<{
          state: string;
          code: string | null;
          attempt: number;
          updated_at: number;
        }>()
    : null;
  const visibleJob =
    downstream ??
    (latest
      ? {
          state: latest.state,
          code: latest.code,
          attempt: 0,
          updated_at: j.updated_at,
        }
      : j);
  const retryTargetId = latest?.request_id ?? w.job_id;
  let stage = "saved";
  let code = w.code ?? j.code;
  if (stale) {
    stage = "blocked";
    code = "INTAKE_SUPERSEDED";
  } else if (cv?.derivative) stage = "ready_for_review";
  else if (cv?.transitionCode) {
    stage = "blocked";
    code = cv.transitionCode;
  } else if (cv) {
    code = cv.code;
    stage =
      cv.state === "queued"
        ? "queued"
        : cv.state === "running"
          ? cv.spec.kind === "range"
            ? "cutting"
            : "planning"
          : cv.proposal
            ? "needs_direction"
            : cv.state === "failed"
              ? "error"
              : "needs_direction";
    if (cv.state === "requested" && cv.spec.kind === "range") {
      stage = "saved";
      code = "CUT_EXECUTION_DISABLED";
    }
  } else if (j.state === "succeeded")
    stage =
      w.code &&
      ![
        "AWAITING_INVENTORY",
        "CAPTURE_PROOF_REQUIRED",
        "NATIVE_PARENT_REQUIRED",
      ].includes(w.code)
        ? "blocked"
        : "awaiting_inventory";
  else if (j.state === "queued") stage = "queued";
  else if (j.state === "running") stage = "downloading";
  else if (j.state === "needs_review") stage = "error";
  else if (j.state !== "blocked" || j.code !== "PROCESSING_DISABLED")
    stage = "blocked";
  return {
    jobId: w.job_id,
    intakeId: w.intake_id,
    intakeRevision: w.intake_revision,
    episodeId: w.episode_id,
    episodeNumber: w.episode_number,
    priority: w.priority,
    state: visibleJob.state,
    stage,
    code,
    attempt: visibleJob.attempt,
    updatedAt: new Date(visibleJob.updated_at).toISOString(),
    stale,
    retryTargetId,
    retryable:
      !stale &&
      !cv?.derivative &&
      !cv?.proposal &&
      !cv?.transitionCode &&
      (latest
        ? downstream?.state === "needs_review" ||
          (!downstream && ["requested", "needs_review"].includes(latest.state))
        : j.state === "needs_review" ||
          (j.state === "blocked" && j.code === "PROCESSING_DISABLED")),
    cutRequest: cv,
    rangeSelection:
      cut &&
      cutWireSchema.parse(JSON.parse(cut.request_json)).spec.kind ===
        "first_pass"
        ? {
            expectedCutRequestId: cut.request_id,
            expectedRequestRevision: await sha256(cut.request_json),
            expectedParentVersion: cut.parent_version,
            expectedRevision: w.intake_revision,
            expectedWorkspaceRevision: w.workspace_revision,
            episodeNumber: w.episode_number,
          }
        : null,
  };
}
export async function listIntakeWork(env: Env, owner: string) {
  if (!intakeWorkEnabled(env))
    return { enabled: false, dispatchEnabled: false, jobs: [] };
  const rows = await env.DB.prepare(
    "SELECT * FROM intake_work_requests WHERE owner=? ORDER BY created_at DESC,job_id LIMIT 100",
  )
    .bind(owner)
    .all<Work>();
  return {
    enabled: true,
    dispatchEnabled: intakeDispatchEnabled(env),
    jobs: await Promise.all(rows.results.map((w) => workView(env, w))),
  };
}
export async function requestIntakeWork(
  env: Env,
  id: string,
  value: unknown,
  owner: string,
  now = Date.now(),
) {
  if (!intakeWorkEnabled(env)) throw unavailable();
  const input = inputSchema.parse(value);
  const jobId = await uuid(
    JSON.stringify(["intake-work/v1", owner, id, input.expectedRevision]),
  );
  const previous = await get(env.DB, jobId, owner);
  if (previous) {
    if (previous.priority !== input.priority) throw conflict();
    return workView(env, previous);
  }
  const row = await env.DB.prepare(
    "SELECT data FROM manual_intake WHERE id=? AND owner=?",
  )
    .bind(id, owner)
    .first<{ data: string }>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Submission not found.");
  const item = JSON.parse(row.data) as ManualIntake;
  if (
    item.revision !== input.expectedRevision ||
    item.status !== "awaiting_processing" ||
    !item.episodeId
  )
    throw conflict();
  const episode = await env.DB.prepare(
    "SELECT data,revision FROM episode_workspaces WHERE id=? AND status='draft' AND is_active=1",
  )
    .bind(item.episodeId)
    .first<{ data: string; revision: number }>();
  if (!episode)
    throw new HttpError(
      409,
      "ACTIVE_EPISODE_REQUIRED",
      "Choose the current active draft episode before requesting work.",
    );
  const number = z
    .number()
    .int()
    .min(1)
    .max(999999)
    .parse(JSON.parse(episode.data).number);
  if (item.whyItMatters.trim().length > 2000 && item.inMs === null)
    throw new HttpError(
      422,
      "GUIDANCE_TOO_LONG",
      "Keep optional cut guidance within 2000 characters; the original submission notes remain saved.",
    );
  const spec = cutSpecSchema.parse(
    item.inMs !== null && item.outMs !== null
      ? {
          kind: "range",
          startSeconds: item.inMs / 1000,
          endSeconds: item.outMs / 1000,
        }
      : {
          kind: "first_pass",
          ...(item.whyItMatters.trim()
            ? { guidance: item.whyItMatters.trim() }
            : {}),
        },
  );
  const wire = JSON.stringify(
    createJobSchema.parse({
      job_id: jobId,
      intake_work_id: jobId,
      show: "twib",
      episode: number,
      url: item.canonicalUrl,
      reported_by: "chad",
    }),
  );
  const queued =
    intakeDispatchEnabled(env) &&
    env.CAPTURE_JOBS_GRANT_EPISODE === String(number);
  const guard =
    "EXISTS(SELECT 1 FROM manual_intake i JOIN episode_workspaces e ON e.id=i.episode_id WHERE i.id=? AND i.owner=? AND i.revision=? AND i.status='awaiting_processing' AND e.id=? AND e.revision=? AND e.status='draft' AND e.is_active=1 AND json_extract(e.data,'$.number')=?)";
  const values = [
    id,
    owner,
    item.revision,
    item.episodeId,
    episode.revision,
    number,
  ];
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO capture_jobs(job_id,request_json,owner,state,operation,code,created_at,updated_at) SELECT ?,?,?,?,'capture',?,?,? WHERE ${guard} AND (SELECT count(*) FROM capture_jobs)<1000`,
    ).bind(
      jobId,
      wire,
      owner,
      queued ? "queued" : "blocked",
      queued ? null : "PROCESSING_DISABLED",
      now,
      now,
      ...values,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO intake_work_requests(job_id,owner,intake_id,intake_revision,episode_id,episode_number,workspace_revision,priority,spec_json,created_at,inventory_episode_id) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} AND EXISTS(SELECT 1 FROM capture_jobs WHERE job_id=? AND request_json=? AND owner=?)`,
    ).bind(
      jobId,
      owner,
      id,
      item.revision,
      item.episodeId,
      number,
      episode.revision,
      input.priority,
      JSON.stringify(spec),
      now,
      await inventoryEpisodeId(number),
      ...values,
      jobId,
      wire,
      owner,
    ),
  ]);
  const saved = await get(env.DB, jobId, owner);
  if (!saved) {
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM capture_jobs",
    ).first<{ n: number }>();
    if ((count?.n ?? 0) >= 1000)
      throw new HttpError(
        429,
        "JOB_CAPACITY",
        "Capture transport capacity requires operator review.",
      );
    throw conflict();
  }
  if (saved.priority !== input.priority) throw conflict();
  return workView(env, saved);
}
export async function retryIntakeWork(
  env: Env,
  id: string,
  jobId: string,
  value: unknown,
  owner: string,
  now = Date.now(),
) {
  if (!intakeWorkEnabled(env)) throw unavailable();
  const input = z
    .object({
      expectedAttempt: z.number().int().nonnegative().max(99),
      expectedTargetId: z.string().uuid().optional(),
    })
    .strict()
    .parse(value);
  const w = await get(env.DB, jobId, owner);
  if (!w || w.intake_id !== id || !(await current(env.DB, w))) throw conflict();
  const view = await workView(env, w);
  const target = input.expectedTargetId ?? jobId;
  if (target !== view.retryTargetId) {
    // A completed earlier stage may be reconciled, but never retry a different stage.
    if (target === jobId || target === w.cut_request_id) return view;
    throw conflict();
  }
  if (w.cut_request_id) {
    const cut = await readCut(env.DB, target);
    if (!cut || cut.owner !== owner) throw conflict();
    const spec = cutWireSchema.parse(JSON.parse(cut.request_json)).spec;
    const planning = spec.kind !== "range";
    if (view.attempt !== input.expectedAttempt) {
      const retryId = await uuid(
        JSON.stringify(["intake-retry/v1", target, input.expectedAttempt]),
      );
      if (
        !(await env.DB.prepare(
          "SELECT 1 FROM capture_job_retries WHERE retry_id=? AND job_id=?",
        )
          .bind(retryId, target)
          .first())
      )
        throw conflict();
      return view;
    }
    if (
      view.state === "queued" ||
      view.state === "running" ||
      cut.derivative_json ||
      cut.proposal_json
    )
      return view;
    if (!(planning ? planningEnabled(env) : executionEnabled(env)))
      throw unavailable();
    if (String(w.episode_number) !== env.CAPTURE_JOBS_GRANT_EPISODE)
      throw conflict();
    if (!view.retryable) throw conflict();
    if (!cut.exec_state) await enqueueCut(env.DB, target, owner, now, planning);
    else
      await retryCut(
        env.DB,
        target,
        {
          retry_id: await uuid(
            JSON.stringify(["intake-retry/v1", target, input.expectedAttempt]),
          ),
        },
        owner,
        now,
        { planning, expectedAttempt: input.expectedAttempt },
      );
    return workView(env, w);
  }
  const job = await env.DB.prepare(
    "SELECT state,attempt,code FROM capture_jobs WHERE job_id=?",
  )
    .bind(jobId)
    .first<{ state: string; attempt: number; code: string | null }>();
  if (!job) throw conflict();
  if (job.state === "succeeded" || w.cut_request_id) return workView(env, w);
  const retryId = await uuid(
    JSON.stringify(["intake-retry/v1", jobId, input.expectedAttempt]),
  );
  if (job.attempt !== input.expectedAttempt) {
    const old = await env.DB.prepare(
      "SELECT 1 FROM capture_job_retries WHERE retry_id=? AND job_id=?",
    )
      .bind(retryId, jobId)
      .first();
    if (!old) throw conflict();
    return workView(env, w);
  }
  if (job.state === "queued" || job.state === "running")
    return workView(env, w);
  if (!intakeDispatchEnabled(env)) throw unavailable();
  if (String(w.episode_number) !== env.CAPTURE_JOBS_GRANT_EPISODE)
    throw conflict();
  const eligibility = {
    sql: `EXISTS(SELECT 1 FROM intake_work_requests w WHERE w.job_id=? AND ${intakeCurrentSql}) AND EXISTS(SELECT 1 FROM capture_jobs q WHERE q.job_id=? AND q.attempt=?)`,
    bindings: [jobId, jobId, input.expectedAttempt],
  };
  if (job.state === "blocked" && job.code === "PROCESSING_DISABLED")
    await env.DB.prepare(
      `UPDATE capture_jobs SET state='queued',code=NULL,updated_at=? WHERE job_id=? AND state='blocked' AND code='PROCESSING_DISABLED' AND ${eligibility.sql}`,
    )
      .bind(now, jobId, ...eligibility.bindings)
      .run();
  else await retryJob(env.DB, jobId, { retry_id: retryId }, now, eligibility);
  return workView(env, w);
}

// Called only after a durable machine receipt or inventory commit, never from GET.
export async function advanceIntakeWork(env: Env, jobId?: string) {
  if (!intakeWorkEnabled(env)) return;
  const rows = await env.DB.prepare(
    `SELECT w.* FROM intake_work_requests w JOIN capture_jobs j ON j.job_id=w.job_id WHERE j.state='succeeded' ${jobId ? "AND w.job_id=?" : "AND w.cut_request_id IS NULL"} AND ${intakeCurrentSql} ORDER BY w.last_checked_at,w.created_at LIMIT 20`,
  )
    .bind(...(jobId ? [jobId] : []))
    .all<Work>();
  for (const w of rows.results) {
    if (!(await current(env.DB, w))) continue;
    try {
      await env.DB.prepare(
        "UPDATE intake_work_requests SET last_checked_at=? WHERE job_id=?",
      )
        .bind(Date.now(), w.job_id)
        .run();
      await advanceOne(env, w);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      await env.DB.prepare(
        "UPDATE intake_work_requests SET code=? WHERE job_id=?",
      )
        .bind(error.code, w.job_id)
        .run();
    }
  }
}
async function advanceOne(env: Env, w: Work) {
  if (w.cut_request_id) {
    // A linked range owns the downstream stage; never re-enqueue its original.
    if (
      await env.DB.prepare(
        "SELECT 1 FROM inventory_cut_requests WHERE source_plan_request_id=?",
      )
        .bind(w.cut_request_id)
        .first()
    )
      return;
    const cut = await readCut(env.DB, w.cut_request_id);
    if (cut) {
      const spec = cutWireSchema.parse(JSON.parse(cut.request_json)).spec;
      if (
        (spec.kind === "range"
          ? executionEnabled(env)
          : planningEnabled(env)) &&
        env.CAPTURE_JOBS_GRANT_EPISODE === String(w.episode_number)
      )
        await enqueueCut(
          env.DB,
          cut.request_id,
          w.owner,
          Date.now(),
          spec.kind !== "range",
        );
    }
    return;
  }
  const deliveries = await env.DB.prepare(
    "SELECT request_json FROM capture_job_deliveries WHERE json_extract(request_json,'$.job_id')=? AND json_extract(request_json,'$.state')='succeeded' AND json_type(request_json,'$.capture')='object' LIMIT 2",
  )
    .bind(w.job_id)
    .all<{ request_json: string }>();
  if (!deliveries.results.length)
    throw new HttpError(
      409,
      "CAPTURE_PROOF_REQUIRED",
      "Waiting for a verified capture receipt.",
    );
  const proofs = deliveries.results.map((d) =>
    captureReceiptSchema.parse(JSON.parse(d.request_json).capture),
  );
  if (
    proofs.length > 1 &&
    JSON.stringify(proofs[0]) !== JSON.stringify(proofs[1])
  )
    throw conflict();
  const proof = proofs[0];
  if (proof.job_id !== w.job_id || proof.episode !== w.episode_number)
    throw conflict();
  if (env.CUT_REQUESTS_ENABLED !== "true")
    throw new HttpError(
      409,
      "CUT_REQUESTS_DISABLED",
      "Captured original retained; cut requests are not activated.",
    );
  const observations = await env.DB.prepare(
    "SELECT receipt_id,sequence,item_json FROM inventory_observations o WHERE source_id=? AND episode_id=? AND json_extract(item_json,'$.media.ref')=? AND sequence=(SELECT max(n.sequence) FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id)",
  )
    .bind(INVENTORY_SOURCE, w.inventory_episode_id, proof.ref)
    .all<{ receipt_id: string; sequence: number; item_json: string }>();
  const matching = observations.results.filter((o) => {
    const i = JSON.parse(o.item_json) as InventoryItem;
    return (
      i.kind === "media" &&
      i.media?.present &&
      i.media.size_bytes === proof.size_bytes &&
      i.media.duration_seconds !== null &&
      Math.abs(i.media.duration_seconds - proof.duration_seconds) <= 0.15 &&
      new Set(
        (i.capture_evidence ?? [])
          .filter((e) => e.matches_observed_size)
          .map((e) => e.producer_sha256)
          .filter(Boolean),
      ).size === 1 &&
      (i.capture_evidence ?? []).some(
        (e) => e.matches_observed_size && e.producer_sha256 === proof.sha256,
      )
    );
  });
  if (matching.length !== 1)
    throw new HttpError(
      409,
      matching.length ? "AMBIGUOUS_CAPTURE_PARENT" : "AWAITING_INVENTORY",
      "Waiting for one matching native inventory original.",
    );
  const obs = matching[0],
    item = JSON.parse(obs.item_json) as InventoryItem;
  const parent = executableCutParentSchema.safeParse({
    item_id: item.id,
    clip_id: item.producer_record?.clip_id ?? null,
    clip_uid: item.producer_record?.clip_uid ?? null,
    ref: proof.ref,
    sha256: proof.sha256,
    size_bytes: proof.size_bytes,
    modified_at: item.media!.modified_at,
  });
  if (!parent.success)
    throw new HttpError(
      409,
      "NATIVE_PARENT_REQUIRED",
      "Waiting for native source identity.",
    );
  if (
    await env.DB.prepare(
      "SELECT 1 FROM inventory_reviews WHERE source_id=? AND episode_id=? AND item_id=?",
    )
      .bind(INVENTORY_SOURCE, w.inventory_episode_id, item.id)
      .first()
  )
    throw new HttpError(
      409,
      "MANUAL_REVIEW_PRESENT",
      "An existing human review must be respected.",
    );
  const spec = cutSpecSchema.parse(JSON.parse(w.spec_json));
  if (spec.kind === "range" && spec.endSeconds > proof.duration_seconds)
    throw new HttpError(
      409,
      "CUT_RANGE_INVALID",
      "Requested range exceeds the captured original.",
    );
  const cutId = await uuid("intake-cut/v1:" + w.job_id),
    version = await inventoryVersion(item),
    now = Date.now();
  const wire = JSON.stringify(
    cutWireSchema.parse({
      job_id: cutId,
      intake_work_id: w.job_id,
      kind: "cut",
      show: "twib",
      episode: w.episode_number,
      reported_by: "chad",
      parent: parent.data,
      spec,
    }),
  );
  const guard = `EXISTS(SELECT 1 FROM intake_work_requests w WHERE w.job_id=? AND w.cut_request_id IS NULL AND ${intakeCurrentSql}) AND EXISTS(SELECT 1 FROM inventory_observations o WHERE source_id=? AND episode_id=? AND item_id=? AND receipt_id=? AND sequence=? AND NOT EXISTS(SELECT 1 FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id AND n.sequence>o.sequence)) AND NOT EXISTS(SELECT 1 FROM inventory_reviews WHERE source_id=? AND episode_id=? AND item_id=?)`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO inventory_cut_requests(request_id,item_id,owner,parent_version,review_revision,request_json,state,created_at,updated_at) SELECT ?,?,?,?,0,?,?,?,? WHERE ${guard}`,
    ).bind(
      cutId,
      item.id,
      w.owner,
      version,
      wire,
      spec.kind === "range" ? "requested" : "needs_review",
      now,
      now,
      w.job_id,
      INVENTORY_SOURCE,
      w.inventory_episode_id,
      item.id,
      obs.receipt_id,
      obs.sequence,
      INVENTORY_SOURCE,
      w.inventory_episode_id,
      item.id,
    ),
    env.DB.prepare(
      "UPDATE intake_work_requests SET cut_request_id=?,code=NULL WHERE job_id=? AND cut_request_id IS NULL AND EXISTS(SELECT 1 FROM inventory_cut_requests WHERE request_id=? AND request_json=?)",
    ).bind(cutId, w.job_id, cutId, wire),
  ]);
  const linked = await get(env.DB, w.job_id, w.owner);
  if (!linked?.cut_request_id) throw conflict();
  await advanceOne(env, linked);
}

const rangeSelectionSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    expectedWorkspaceRevision: z.number().int().positive(),
    episodeNumber: z.number().int().min(1).max(999999),
    expectedCutRequestId: z.string().uuid(),
    expectedRequestRevision: z.string().regex(/^[a-f0-9]{64}$/),
    expectedParentVersion: z.string().regex(/^[a-f0-9]{64}$/),
    range: cutSpecSchema.refine((v) => v.kind === "range"),
  })
  .strict();

// Owner-only selection of a range from an already captured original. This is
// processing direction, not a model proposal or editorial approval. Both original
// work intent and first-pass request stay immutable; the existing unique child
// link makes competing selections conflict without a new capture or migration.
export async function selectIntakeRange(
  env: Env,
  intakeId: string,
  jobId: string,
  value: unknown,
  owner: string,
  now = Date.now(),
) {
  if (!intakeWorkEnabled(env)) throw unavailable();
  const input = rangeSelectionSchema.parse(value);
  const db = env.DB;
  const w = await get(db, jobId, owner);
  if (
    !w ||
    w.intake_id !== intakeId ||
    w.intake_revision !== input.expectedRevision ||
    w.workspace_revision !== input.expectedWorkspaceRevision ||
    w.episode_number !== input.episodeNumber ||
    w.cut_request_id !== input.expectedCutRequestId ||
    !(await current(db, w))
  )
    throw conflict();
  const cut = await readCut(db, input.expectedCutRequestId);
  if (
    !cut ||
    cut.owner !== owner ||
    cut.review_revision !== 0 ||
    cut.source_plan_request_id ||
    cut.parent_version !== input.expectedParentVersion ||
    (await sha256(cut.request_json)) !== input.expectedRequestRevision ||
    cut.state !== "needs_review" ||
    cut.exec_state ||
    cut.proposal_json ||
    cut.derivative_json ||
    cut.transition_code
  )
    throw conflict();
  const original = cutWireSchema.parse(JSON.parse(cut.request_json));
  if (
    original.spec.kind !== "first_pass" ||
    original.intake_work_id !== jobId ||
    original.episode !== w.episode_number ||
    original.editorial ||
    !executableCutParentSchema.safeParse(original.parent).success ||
    !original.parent.sha256
  )
    throw conflict();
  if (
    !(await db
      .prepare(
        "SELECT 1 FROM capture_jobs WHERE job_id=? AND owner=? AND state='succeeded'",
      )
      .bind(jobId, owner)
      .first())
  )
    throw conflict();
  const { episode, obs, duplicateId } = await eligibility(db, cut, true);
  const item = JSON.parse(obs.item_json) as InventoryItem;
  if (
    !item.media?.present ||
    item.media.ref !== original.parent.ref ||
    item.media.size_bytes !== original.parent.size_bytes ||
    item.media.modified_at !== original.parent.modified_at ||
    (item.producer_record?.clip_id ?? null) !== original.parent.clip_id ||
    (item.producer_record?.clip_uid ?? null) !== original.parent.clip_uid ||
    item.media.duration_seconds === null ||
    input.range.kind !== "range" ||
    input.range.endSeconds > item.media.duration_seconds ||
    !item.capture_evidence?.some(
      (e) =>
        e.matches_observed_size && e.producer_sha256 === original.parent.sha256,
    )
  )
    throw conflict();
  const id = await uuid("intake-owner-range/v1:" + cut.request_id);
  const request = JSON.stringify(
    cutWireSchema.parse({ ...original, job_id: id, spec: input.range }),
  );
  const result = {
    requestId: id,
    sourcePlanRequestId: cut.request_id,
    selectionOrigin: "owner_range" as const,
  };
  const previous = await readCut(db, id);
  if (previous) {
    if (
      previous.owner !== owner ||
      previous.source_plan_request_id !== cut.request_id ||
      previous.request_json !== request
    )
      throw conflict();
    return result; // Acknowledging committed intent does not renew an expired grant.
  }
  const starts = Date.parse(env.CAPTURE_JOBS_GRANT_STARTS_AT ?? "");
  const expires = Date.parse(env.CAPTURE_JOBS_GRANT_EXPIRES_AT ?? "");
  if (
    !executionEnabled(env) ||
    env.CAPTURE_JOBS_GRANT_SOURCE_ID !== "nomad:capture-worker" ||
    env.CAPTURE_JOBS_GRANT_SHOW !== "twib" ||
    env.CAPTURE_JOBS_GRANT_SCOPES !== "job:claim,job:result" ||
    env.CAPTURE_JOBS_GRANT_EPISODE !== String(w.episode_number) ||
    !Number.isFinite(starts) ||
    !Number.isFinite(expires) ||
    expires <= starts ||
    expires - starts > 86400000 ||
    now < starts ||
    now >= expires
  )
    throw conflict();
  const guard = `EXISTS(SELECT 1 FROM intake_work_requests w JOIN capture_jobs j ON j.job_id=w.job_id WHERE w.job_id=? AND w.owner=? AND w.cut_request_id=? AND j.state='succeeded' AND ${intakeCurrentSql})
    AND EXISTS(SELECT 1 FROM inventory_cut_requests c WHERE c.request_id=? AND c.owner=? AND c.request_json=? AND c.state='needs_review' AND c.proposal_json IS NULL AND c.derivative_json IS NULL AND c.transition_code IS NULL AND NOT EXISTS(SELECT 1 FROM capture_jobs j WHERE j.job_id=c.request_id))
    AND EXISTS(SELECT 1 FROM inventory_observations o WHERE source_id=? AND episode_id=? AND item_id=? AND receipt_id=? AND sequence=? AND NOT EXISTS(SELECT 1 FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id AND n.sequence>o.sequence))
    AND EXISTS(SELECT 1 FROM ${authorizationTable(cut)} WHERE source_id=? AND episode_id=? AND item_id=? AND revision=0 AND status='cut_down' AND reviewed_version=?)
    AND NOT EXISTS(SELECT 1 FROM inventory_observations d WHERE d.source_id=? AND d.episode_id=? AND d.item_id<>? AND coalesce(json_extract(d.item_json,'$.producer_record.clip_uid'),json_extract(d.item_json,'$.producer_record.clip_id'))=? AND json_extract(d.item_json,'$.media.present')=1 AND d.sequence=(SELECT max(n.sequence) FROM inventory_observations n WHERE n.source_id=d.source_id AND n.episode_id=d.episode_id AND n.item_id=d.item_id))`;
  const bindings = [
    jobId,
    owner,
    cut.request_id,
    cut.request_id,
    owner,
    cut.request_json,
    INVENTORY_SOURCE,
    episode,
    cut.item_id,
    obs.receipt_id,
    obs.sequence,
    INVENTORY_SOURCE,
    episode,
    cut.item_id,
    cut.parent_version,
    INVENTORY_SOURCE,
    episode,
    cut.item_id,
    duplicateId,
  ];
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO inventory_cut_requests(request_id,item_id,owner,parent_version,review_revision,request_json,state,source_plan_request_id,created_at,updated_at) SELECT ?,?,?,?,0,?,'queued',?,?,? WHERE ${guard}`,
      )
      .bind(
        id,
        cut.item_id,
        owner,
        cut.parent_version,
        request,
        cut.request_id,
        now,
        now,
        ...bindings,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO capture_jobs(job_id,request_json,owner,state,operation,created_at,updated_at) SELECT ?,?,?,'queued','capture',?,? WHERE EXISTS(SELECT 1 FROM inventory_cut_requests WHERE request_id=? AND source_plan_request_id=? AND request_json=? AND owner=?) AND ${guard}`,
      )
      .bind(
        id,
        request,
        owner,
        now,
        now,
        id,
        cut.request_id,
        request,
        owner,
        ...bindings,
      ),
  ]);
  const saved = await readCut(db, id);
  if (
    !saved ||
    saved.source_plan_request_id !== cut.request_id ||
    saved.request_json !== request ||
    saved.exec_state !== "queued"
  )
    throw conflict();
  return result;
}
