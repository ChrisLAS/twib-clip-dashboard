import { z } from "zod";
import {
  validateIntakeUrl,
  validateIntakeRange,
  type IntakeCreateInput,
  type IntakeUpdateInput,
  type IntakeDuplicateMatch,
  type IntakeList,
  type IntakeMutationResult,
  type ManualIntake,
} from "@twib/shared";
import { HttpError } from "./errors";
import { fingerprint, operation } from "./store";

const mutationFields = {
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: z
    .string()
    .min(8)
    .max(120)
    .regex(/^[a-zA-Z0-9_-]+$/),
};
const editableFields = {
  episodeId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .nullable()
    .optional(),
  inMs: z.number().int().nonnegative().max(604_800_000).nullable().optional(),
  outMs: z.number().int().positive().max(604_800_000).nullable().optional(),
  whyItMatters: z.string().max(5000).optional(),
  allowDifferentRange: z.boolean().optional(),
};
export const intakeCreateSchema = z
  .object({
    ...mutationFields,
    ...editableFields,
    expectedRevision: z.literal(0),
    episodeId: editableFields.episodeId.unwrap(),
    kind: z.enum(["already_cut", "full_source"]),
    url: z.string().min(1).max(2048),
  })
  .strict();
export const intakeUpdateSchema = z
  .object({
    ...mutationFields,
    ...editableFields,
    action: z.enum(["update", "cancel", "restore"]),
  })
  .strict()
  .refine(
    (value) =>
      value.action === "update" ||
      (value.episodeId === undefined &&
        value.inMs === undefined &&
        value.outMs === undefined &&
        value.whyItMatters === undefined),
    "Only an update may edit the submission.",
  );

export async function listIntake(
  db: D1Database,
  owner: string,
  episodeId?: string | null,
): Promise<IntakeList> {
  const row = await db
    .prepare(
      `SELECT intake_version AS version,(SELECT json_group_array(json(data)) FROM (SELECT data FROM manual_intake WHERE owner=? ${episodeId !== undefined ? "AND episode_id IS ?" : ""} ORDER BY json_extract(data,'$.createdAt') DESC,id LIMIT 1001)) AS items FROM workspace_state WHERE id=1`,
    )
    .bind(owner, ...(episodeId !== undefined ? [episodeId] : []))
    .first<{ version: number; items: string }>();
  if (!row)
    throw new HttpError(
      503,
      "INTAKE_UNAVAILABLE",
      "Manual submissions are unavailable.",
    );
  const items = JSON.parse(row.items) as ManualIntake[];
  if (items.length > 1000)
    throw new HttpError(
      503,
      "INTAKE_LIMIT",
      "Too many submissions to load safely. Choose an episode.",
    );
  return { version: row.version, items };
}
async function readIntake(
  db: D1Database,
  id: string,
  owner: string,
): Promise<ManualIntake> {
  const row = await db
    .prepare("SELECT data FROM manual_intake WHERE id=? AND owner=?")
    .bind(id, owner)
    .first<{ data: string }>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Submission not found.");
  return JSON.parse(row.data) as ManualIntake;
}
async function checkEpisode(
  db: D1Database,
  episodeId: string | null,
  cancellation = false,
): Promise<void> {
  if (episodeId === null) return;
  const row = await db
    .prepare(
      "SELECT w.status FROM (SELECT id FROM episodes UNION SELECT id FROM episode_workspaces) e LEFT JOIN episode_workspaces w ON w.id=e.id WHERE e.id=?",
    )
    .bind(episodeId)
    .first<{ status: string | null }>();
  if (!row)
    throw new HttpError(
      422,
      "INVALID_EPISODE",
      "Choose an existing episode or Unassigned.",
    );
  if (row.status === "archived" && !cancellation)
    throw new HttpError(
      409,
      "WORKSPACE_ARCHIVED",
      "This episode workspace is archived. Choose another episode.",
    );
}
async function duplicates(
  db: D1Database,
  owner: string,
  intake: ManualIntake,
): Promise<IntakeDuplicateMatch[]> {
  const pending = await db
    .prepare(
      "SELECT id,episode_id,in_ms,out_ms FROM manual_intake WHERE owner=? AND status='awaiting_processing' AND canonical_url=? AND id<>?",
    )
    .bind(owner, intake.canonicalUrl, intake.id)
    .all<{
      id: string;
      episode_id: string | null;
      in_ms: number | null;
      out_ms: number | null;
    }>();
  const matches: IntakeDuplicateMatch[] = pending.results.map((row) => ({
    kind: "intake",
    id: row.id,
    episodeId: row.episode_id,
    rangeMatch:
      row.in_ms === intake.inMs && row.out_ms === intake.outMs
        ? "exact"
        : "different",
  }));
  // This bounded read sees immutable imported source metadata only; no URL is
  // fetched and no artifact/download/producer endpoint is invoked.
  const renders = await db
    .prepare(
      "SELECT renders.id,clips.episode_id,json_extract(renders.data,'$.source.url') AS url,json_extract(renders.data,'$.source.inMs') AS in_ms,json_extract(renders.data,'$.source.outMs') AS out_ms FROM renders JOIN clips ON clips.id=renders.clip_id WHERE json_extract(renders.data,'$.source.url') IS NOT NULL LIMIT 5001",
    )
    .all<{
      id: string;
      episode_id: string;
      url: string;
      in_ms: number;
      out_ms: number;
    }>();
  if (renders.results.length > 5000)
    throw new HttpError(
      503,
      "DUPLICATE_CHECK_LIMIT",
      "The source index is too large to check safely. No submission was saved.",
    );
  for (const row of renders.results) {
    const normalized = validateIntakeUrl(row.url);
    if (normalized.ok && normalized.canonicalUrl === intake.canonicalUrl)
      matches.push({
        kind: "render",
        id: row.id,
        episodeId: row.episode_id,
        rangeMatch:
          row.in_ms === intake.inMs && row.out_ms === intake.outMs
            ? "exact"
            : "different",
      });
  }
  return matches;
}
function rejectDuplicates(
  matches: IntakeDuplicateMatch[],
  allowDifferentRange: boolean,
): void {
  const exact = matches.filter((match) => match.rangeMatch === "exact");
  if (exact.length)
    throw new HttpError(
      409,
      "DUPLICATE_INTAKE",
      "This source and range already have a saved submission or imported render. Open the existing item, or choose a different cut.",
      undefined,
      matches,
    );
  if (matches.length && !allowDifferentRange)
    throw new HttpError(
      409,
      "DUPLICATE_SOURCE",
      "This source is already present with a different range. Confirm that you intend to save a different cut.",
      undefined,
      matches,
    );
}
async function replay(
  db: D1Database,
  key: string,
  fp: string,
): Promise<IntakeMutationResult | null> {
  const saved = await operation(db, key);
  if (!saved) return null;
  if (saved.fingerprint !== fp)
    throw new HttpError(
      409,
      "IDEMPOTENCY_REUSE",
      "This request key belongs to different content.",
    );
  return JSON.parse(saved.response) as IntakeMutationResult;
}
/** A single INSERT plus triggers atomically commits event, projection, clock and receipt. */
export async function mutateIntake(
  db: D1Database,
  id: string | null,
  rawInput: IntakeCreateInput | IntakeUpdateInput,
  owner: string,
): Promise<IntakeMutationResult> {
  const input =
    id === null
      ? intakeCreateSchema.parse(rawInput)
      : intakeUpdateSchema.parse(rawInput);
  const action = "action" in input ? input.action : "create";
  const fp = await fingerprint({ kind: "intake", id, input, owner });
  const prior = await replay(db, input.idempotencyKey, fp);
  if (prior) return prior;
  try {
    const now = new Date().toISOString();
    const existing = id === null ? null : await readIntake(db, id, owner);
    if (existing && existing.revision !== input.expectedRevision)
      throw new HttpError(
        409,
        "REVISION_CONFLICT",
        "A newer submission change was saved. Refresh before trying again.",
        existing.revision,
      );
    if (
      existing &&
      (action === "restore") !== (existing.status === "cancelled")
    )
      throw new HttpError(
        409,
        "INTAKE_STATE_CONFLICT",
        existing.status === "cancelled"
          ? "Restore this submission before editing it."
          : "This submission is already active.",
        existing.revision,
      );
    let intake: ManualIntake;
    if ("url" in input) {
      const url = validateIntakeUrl(input.url);
      if (!url.ok) throw new HttpError(422, "UNSAFE_SOURCE_URL", url.error);
      intake = {
        id: crypto.randomUUID(),
        episodeId: input.episodeId,
        kind: input.kind,
        submittedUrl: url.submittedUrl,
        canonicalUrl: url.canonicalUrl,
        provider: url.provider,
        inMs: input.inMs ?? null,
        outMs: input.outMs ?? null,
        whyItMatters: input.whyItMatters ?? "",
        status: "awaiting_processing",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
    } else {
      if (!existing)
        throw new HttpError(404, "NOT_FOUND", "Submission not found.");
      intake = {
        ...existing,
        episodeId:
          input.episodeId === undefined ? existing.episodeId : input.episodeId,
        inMs: input.inMs === undefined ? existing.inMs : input.inMs,
        outMs: input.outMs === undefined ? existing.outMs : input.outMs,
        whyItMatters: input.whyItMatters ?? existing.whyItMatters,
        status: action === "cancel" ? "cancelled" : "awaiting_processing",
        revision: input.expectedRevision + 1,
        updatedAt: now,
      };
    }
    const rangeError = validateIntakeRange(intake.inMs, intake.outMs);
    if (rangeError) throw new HttpError(422, "INVALID_RANGE", rangeError);
    await checkEpisode(db, intake.episodeId, action === "cancel");
    const catalog = await db
      .prepare("SELECT version FROM sync_state WHERE id=1")
      .first<{ version: number }>();
    if (!catalog)
      throw new HttpError(
        503,
        "INTAKE_UNAVAILABLE",
        "Manual submissions are unavailable.",
      );
    const unchangedRange =
      action === "update" &&
      existing?.inMs === intake.inMs &&
      existing?.outMs === intake.outMs;
    const allowDifferentRange =
      input.allowDifferentRange === true || unchangedRange;
    if (action !== "cancel" && !unchangedRange)
      rejectDuplicates(
        await duplicates(db, owner, intake),
        allowDifferentRange,
      );
    try {
      await db
        .prepare(
          "INSERT INTO intake_events(id,operation_id,intake_id,owner,action,expected_revision,expected_catalog_version,allow_different_range,data,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          input.idempotencyKey,
          intake.id,
          owner,
          action,
          input.expectedRevision,
          catalog.version,
          allowDifferentRange ? 1 : 0,
          JSON.stringify(intake),
          fp,
        )
        .run();
    } catch {
      const raced = await replay(db, input.idempotencyKey, fp);
      if (raced) return raced;
      if (id !== null) {
        const current = await readIntake(db, id, owner);
        if (current.revision !== input.expectedRevision)
          throw new HttpError(
            409,
            "REVISION_CONFLICT",
            "A newer submission change was saved. Refresh before trying again.",
            current.revision,
          );
      }
      await checkEpisode(db, intake.episodeId, action === "cancel");
      if (action !== "cancel")
        rejectDuplicates(
          await duplicates(db, owner, intake),
          allowDifferentRange,
        );
      const clock = await db
        .prepare("SELECT version FROM sync_state WHERE id=1")
        .first<{ version: number }>();
      if (clock?.version !== catalog.version)
        throw new HttpError(
          409,
          "CATALOG_CONFLICT",
          "The imported catalog changed while checking this source. Refresh and check for duplicates again.",
        );
      throw new HttpError(
        503,
        "SAVE_FAILED",
        "Save could not be confirmed. Reconcile the request before retrying.",
      );
    }
    const saved = await replay(db, input.idempotencyKey, fp);
    if (!saved)
      throw new HttpError(
        503,
        "SAVE_FAILED",
        "Save could not be confirmed. Reconcile the request before retrying.",
      );
    return saved;
  } catch (error) {
    // A simultaneous identical request may commit during preflight reads,
    // before this invocation reaches its INSERT. Reconcile those races too.
    const raced = await replay(db, input.idempotencyKey, fp);
    if (raced) return raced;
    throw error;
  }
}
