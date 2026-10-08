import { z } from "zod";
import type {
  AiringDecisionInput,
  AiringEvidence,
  AiringEvidenceInput,
  AiringEvidenceList,
  Render,
} from "@twib/shared";
import { HttpError } from "./errors";
import { fingerprint, getRender, operation } from "./store";
import { getPublishedEdition } from "./publication";
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const range = z
  .object({
    startMs: z.number().int().nonnegative().max(604800000),
    endMs: z.number().int().positive().max(604800000),
  })
  .strict()
  .refine((v) => v.endMs > v.startMs);
export const airingInputSchema = z
  .object({
    idempotencyKey: id.min(8),
    renderId: id,
    episodeId: id,
    renderArtifactHash: hash,
    sourceFingerprint: hash,
    episodeEditionFingerprint: hash,
    episodeTranscriptHash: hash,
    algorithmVersion: z.literal("bounded-passage-v1"),
    status: z.enum(["CANDIDATE", "UNKNOWN"]),
    reason: z.enum([
      "passages_require_verification",
      "transcript_unavailable",
      "no_distinctive_match",
      "search_limit_reached",
    ]),
    sourceCoordinateSpace: z.literal("clip_render"),
    exactRenderIdentity: z.literal("not_established_by_text"),
    searchComplete: z.boolean(),
    passages: z
      .array(
        z
          .object({
            sourceRange: range,
            episodeRange: range,
            timingPrecision: z.literal("enclosing_cues"),
            quality: z.enum([
              "exact_normalized_passage",
              "near_normalized_passage",
            ]),
            matchedTokens: z.number().int().min(24).max(30000),
            editedTokens: z.number().int().min(0).max(3),
            distinctiveTokens: z.number().int().min(10).max(30000),
            ambiguity: z.enum(["multiple_locations", "not_detected"]),
            sourceExcerpt: z.string().min(1).max(2500),
            episodeExcerpt: z.string().min(1).max(2500),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.status === "CANDIDATE") !== v.passages.length > 0 ||
      (v.status === "CANDIDATE") !==
        (v.reason === "passages_require_verification")
    )
      ctx.addIssue({
        code: "custom",
        message: "Candidate passages and reason must agree.",
      });
  });
export const airingDecisionSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: id.min(8),
    decision: z.enum(["full", "partial", "unknown", "undo"]),
    note: z.string().max(3000),
    verification: z.enum(["listened_compared_exact_render", "none"]),
  })
  .strict()
  .refine(
    (v) =>
      !["full", "partial"].includes(v.decision) ||
      v.verification === "listened_compared_exact_render",
  );
interface EvidenceRow {
  id: string;
  owner: string;
  render_id: string;
  episode_id: string;
  data: string;
  revision: number;
  decision: "full" | "partial" | "unknown";
  note: string;
  verified_at: string | null;
}
function sourceIdentity(render: Render) {
  return {
    renderId: render.id,
    artifactHash: render.artifactHash,
    recipeHash: render.recipeHash,
    source: render.source,
    cues: render.cues,
    mappingVerified: render.mappingVerified,
    durationMs: render.durationMs,
  };
}
export function airingSourceFingerprint(render: Render): Promise<string> {
  return fingerprint(sourceIdentity(render));
}
async function freshness(
  db: D1Database,
  data: AiringEvidenceInput,
  render: Render,
): Promise<string | null> {
  if (
    !render.artifactHash ||
    render.artifactHash !== data.renderArtifactHash ||
    (await airingSourceFingerprint(render)) !== data.sourceFingerprint
  )
    return "Source or exact render edition changed.";
  const current = await db
    .prepare(
      "SELECT json_extract(data,'$.currentRenderId') AS render_id FROM clips WHERE id=?",
    )
    .bind(render.clipId)
    .first<{ render_id: string }>();
  if (current?.render_id !== render.id)
    return "A newer clip render is current; this evidence remains historical.";
  const edition = await getPublishedEdition(db, data.episodeId);
  if (
    !edition ||
    edition.editionFingerprint !== data.episodeEditionFingerprint ||
    edition.transcriptHash !== data.episodeTranscriptHash
  )
    return "Published episode or transcript edition changed or is unavailable.";
  return null;
}
async function project(
  db: D1Database,
  row: EvidenceRow,
  render: Render,
): Promise<AiringEvidence> {
  const data = JSON.parse(row.data) as AiringEvidenceInput & {
    createdAt: string;
  };
  const staleReason = await freshness(db, data, render);
  // Exact input idempotency key is stored separately in operation receipts.
  return {
    ...data,
    id: row.id,
    revision: row.revision,
    decision: row.decision,
    note: row.note,
    verifiedAt: row.verified_at,
    freshness: staleReason ? "stale" : "current",
    staleReason,
  };
}
export async function listAiringEvidence(
  db: D1Database,
  renderId: string,
  owner: string,
): Promise<AiringEvidenceList> {
  const render = await getRender(db, renderId);
  const rows = await db
    .prepare(
      "SELECT * FROM airing_evidence WHERE owner=? AND render_id=? ORDER BY rowid DESC LIMIT 50",
    )
    .bind(owner, renderId)
    .all<EvidenceRow>();
  return {
    renderId,
    sourceFingerprint: await airingSourceFingerprint(render),
    evidence: await Promise.all(
      rows.results.map((row) => project(db, row, render)),
    ),
    matching: "offline_candidate_ingestion",
    exactRenderIdentity: "requires_owner_verification",
  };
}
async function priorOperation(
  db: D1Database,
  key: string,
  fp: string,
  owner: string,
) {
  const prior = await operation(db, key, owner);
  if (!prior) {
    if (await operation(db, key))
      throw new HttpError(
        409,
        "IDEMPOTENCY_REUSE",
        "This request key is unavailable. Use a new key for a new operation.",
      );
    return null;
  }
  if (prior.fingerprint !== fp)
    throw new HttpError(
      409,
      "IDEMPOTENCY_REUSE",
      "This request key belongs to different content.",
    );
  return JSON.parse(prior.response) as Record<string, unknown>;
}
export async function ingestAiringEvidence(
  db: D1Database,
  input: AiringEvidenceInput,
  owner: string,
): Promise<unknown> {
  input = airingInputSchema.parse(input);
  const fp = await fingerprint({ kind: "airing_ingest", input, owner });
  const prior = await priorOperation(db, input.idempotencyKey, fp, owner);
  if (prior) return prior;
  const render = await getRender(db, input.renderId);
  if (input.status === "CANDIDATE" && !render.mappingVerified)
    throw new HttpError(
      422,
      "UNVERIFIED_MAPPING",
      "Candidate passages require verified render-relative transcript mapping.",
    );
  const stale = await freshness(db, input, render);
  if (stale) throw new HttpError(409, "STALE_EVIDENCE", stale);
  if (input.passages.some((p) => p.sourceRange.endMs > render.durationMs))
    throw new HttpError(
      422,
      "OUT_OF_RANGE",
      "Candidate passage exceeds the exact render duration.",
    );
  const payload = { ...input };
  delete (payload as Partial<AiringEvidenceInput>).idempotencyKey;
  const evidenceFp = await fingerprint({ owner, payload });
  const evidenceId = "air-" + evidenceFp.slice(0, 48);
  const createdAt = new Date().toISOString();
  const response = { id: evidenceId, revision: 0, decision: "unknown" };
  try {
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO airing_evidence(id,owner,render_id,episode_id,fingerprint,data,source_snapshot) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          evidenceId,
          owner,
          input.renderId,
          input.episodeId,
          evidenceFp,
          JSON.stringify({ ...payload, createdAt }),
          JSON.stringify(sourceIdentity(render)),
        ),
      db
        .prepare(
          "INSERT INTO operations(id,fingerprint,response) SELECT ?,?,json_object('id',id,'revision',revision,'decision',decision) FROM airing_evidence WHERE id=? AND owner=?",
        )
        .bind(input.idempotencyKey, fp, evidenceId, owner),
      db
        .prepare("INSERT INTO operation_owners VALUES(?,?)")
        .bind(input.idempotencyKey, owner),
    ]);
  } catch {
    const raced = await priorOperation(db, input.idempotencyKey, fp, owner);
    if (raced) return raced;
    throw new HttpError(
      503,
      "SAVE_UNCONFIRMED",
      "Candidate save could not be confirmed. Reuse the same request key.",
    );
  }
  return (
    (await priorOperation(db, input.idempotencyKey, fp, owner)) ?? response
  );
}
export async function decideAiringEvidence(
  db: D1Database,
  evidenceId: string,
  input: AiringDecisionInput,
  owner: string,
): Promise<unknown> {
  input = airingDecisionSchema.parse(input);
  const fp = await fingerprint({
    kind: "airing_decision",
    evidenceId,
    input,
    owner,
  });
  const prior = await priorOperation(db, input.idempotencyKey, fp, owner);
  if (prior) return prior;
  const row = await db
    .prepare("SELECT * FROM airing_evidence WHERE id=? AND owner=?")
    .bind(evidenceId, owner)
    .first<EvidenceRow>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Airing evidence not found.");
  if (row.revision !== input.expectedRevision)
    throw new HttpError(
      409,
      "REVISION_CONFLICT",
      "A newer verification was saved. Refresh before retrying.",
      row.revision,
    );
  const data = JSON.parse(row.data) as AiringEvidenceInput;
  // Clearing/undo remains possible for historical evidence; new confirmation cannot.
  if (["full", "partial"].includes(input.decision)) {
    const stale = await freshness(db, data, await getRender(db, row.render_id));
    if (stale) throw new HttpError(409, "STALE_EVIDENCE", stale);
  }
  let decision = input.decision === "undo" ? "unknown" : input.decision;
  let note = input.note;
  if (input.decision === "undo") {
    // Undo always withdraws a confirmation. It never revives older positive claims.
    decision = "unknown";
    note = input.note || "Owner withdrew the previous airing decision.";
  }
  try {
    await db
      .prepare("INSERT INTO airing_events VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .bind(
        crypto.randomUUID(),
        input.idempotencyKey,
        evidenceId,
        owner,
        input.expectedRevision,
        decision,
        input.decision,
        note,
        input.verification,
        new Date().toISOString(),
        fp,
      )
      .run();
  } catch {
    const raced = await priorOperation(db, input.idempotencyKey, fp, owner);
    if (raced) return raced;
    throw new HttpError(
      409,
      "REVISION_CONFLICT",
      "A newer verification or episode edition may have arrived. Refresh before retrying.",
    );
  }
  return priorOperation(db, input.idempotencyKey, fp, owner);
}
