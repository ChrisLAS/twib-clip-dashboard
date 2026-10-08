import { z } from "zod";
import {
  editorialContextValue,
  type EditorialProfile,
  type EditorialContext,
  type EditorialReceipt,
  type EditorialReceiptInput,
} from "../../../packages/shared/src/editorial";
import { HttpError } from "./errors";
import { fingerprint } from "./store";
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);
const scope = z.enum(["global", "episode", "render"]);
const common = {
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: id.min(8),
  reason: z.string().trim().min(1).max(5000),
  scope,
};
const rule = z
  .object({
    id,
    text: z.string().trim().min(1).max(2000),
    scope,
    episodeId: id.nullable(),
    renderId: id.nullable(),
    evidenceIds: z.array(id).max(100),
  })
  .strict()
  .refine(
    (r) =>
      r.scope === "global"
        ? r.episodeId === null && r.renderId === null
        : r.scope === "episode"
          ? r.episodeId !== null && r.renderId === null
          : r.episodeId !== null && r.renderId !== null,
    "Scope must identify exactly its target.",
  );
export const editorialProfileSchema = z
  .object({
    ...common,
    action: z.enum(["replace", "disable", "enable", "undo"]),
    rules: z.array(rule).max(100).optional(),
    undoVersion: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.action === "replace") === (v.rules !== undefined) &&
      (v.action === "undo") === (v.undoVersion !== undefined),
    "Supply rules only for replace, undoVersion only for undo.",
  );
export const editorialFeedbackSchema = z
  .object({
    ...common,
    reason: z.string().max(5000),
    action: z.enum(["record", "propose", "confirm", "dismiss"]),
    decision: z.enum(["up", "down", "defer", "clear"]),
    episodeId: id.nullable().optional(),
    renderId: id.nullable().optional(),
    proposalId: id.optional(),
    ruleText: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (v) => v.action === "record" || v.reason.trim().length > 0,
    "A proposal or confirmation requires an explicit reason.",
  )
  .refine(
    (v) => v.action !== "propose" || v.ruleText !== undefined,
    "A proposal requires ruleText.",
  )
  .refine(
    (v) =>
      !["confirm", "dismiss"].includes(v.action) || v.proposalId !== undefined,
    "Select a proposal.",
  )
  .refine(
    (v) =>
      v.scope === "global"
        ? !v.episodeId && !v.renderId
        : v.scope === "episode"
          ? !!v.episodeId && !v.renderId
          : !!v.episodeId && !!v.renderId,
    "Scope must identify exactly its target.",
  );
export const editorialReceiptSchema = z
  .object({
    actor: z.enum(["owner", "assistant"]).default("owner"),
    idempotencyKey: id.min(8),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/),
    profileVersion: z.number().int().nonnegative(),
    episodeId: id.nullable(),
    renderId: id.nullable().optional(),
    stage: z.enum(["research", "selection", "cutting", "rendering"]),
    usedRuleIds: z.array(id).max(100),
    changedBecauseFeedback: z.boolean(),
    evidenceIds: z.array(id).max(100),
    explanation: z.string().trim().min(1).max(5000),
  })
  .strict();
const empty = (): EditorialProfile => ({
  version: 0,
  enabled: true,
  rules: [],
  feedback: [],
  proposals: [],
  updatedAt: null,
});
export async function getEditorialProfile(
  db: D1Database,
  owner: string,
): Promise<EditorialProfile> {
  const row = await db
    .prepare("SELECT data FROM editorial_profiles WHERE owner=?")
    .bind(owner)
    .first<{ data: string }>();
  return row ? JSON.parse(row.data) : empty();
}
async function atVersion(
  db: D1Database,
  owner: string,
  version: number,
): Promise<EditorialProfile> {
  if (version === 0) return empty();
  const row = await db
    .prepare(
      "SELECT data FROM editorial_events WHERE owner=? AND expected_revision=?",
    )
    .bind(owner, version - 1)
    .first<{ data: string }>();
  if (!row)
    throw new HttpError(
      404,
      "EDITORIAL_VERSION_NOT_FOUND",
      "Editorial version not found.",
    );
  return JSON.parse(row.data);
}
/** Same bounded query is used by the authorized read-only D1 adapter. */
export const editorialReviewExamplesSql = `WITH latest AS (
 SELECT re.*,re.rowid AS insertionOrder,ROW_NUMBER() OVER(PARTITION BY re.render_id ORDER BY re.rowid DESC) AS latestRank
 FROM review_events re WHERE re.reviewer=?
), examples AS (
 SELECT latest.id,latest.render_id AS renderId,c.episode_id AS episodeId,latest.decision,latest.note,latest.reason,latest.occurred_at AS occurredAt,
 coalesce(json_extract(c.data,'$.currentRenderId')=r.id,0) AS isCurrentRender,
 coalesce(c.episode_id=?2,0) AS isCurrentEpisode,
 ROW_NUMBER() OVER(PARTITION BY latest.decision ORDER BY coalesce(r.id=?3,0) DESC,coalesce(c.episode_id=?2,0) DESC,coalesce(json_extract(c.data,'$.currentRenderId')=r.id,0) DESC,latest.insertionOrder DESC) AS decisionRank
 FROM latest JOIN renders r ON r.id=latest.render_id JOIN clips c ON c.id=r.clip_id
 WHERE latest.latestRank=1 AND latest.decision<>'clear'
)
SELECT id,renderId,episodeId,decision,note,reason,occurredAt,isCurrentRender,isCurrentEpisode
FROM examples ORDER BY decisionRank,isCurrentEpisode DESC,isCurrentRender DESC,decision,renderId LIMIT 101`;
export async function getEditorialContext(
  db: D1Database,
  owner: string,
  episodeId: string | null = null,
  renderId: string | null = null,
  version?: number,
): Promise<EditorialContext> {
  if (
    (episodeId !== null && !id.safeParse(episodeId).success) ||
    (renderId !== null && !id.safeParse(renderId).success) ||
    (renderId !== null && episodeId === null)
  )
    throw new HttpError(
      400,
      "INVALID_CONTEXT_TARGET",
      "Choose a valid episode and its exact render.",
    );
  await validateTargets(db, episodeId, renderId);
  const profile =
    version === undefined
      ? await getEditorialProfile(db, owner)
      : await atVersion(db, owner, version);
  const value = editorialContextValue(profile, episodeId, renderId);
  const contextHash = await fingerprint(value);
  const examples = await db
    .prepare(editorialReviewExamplesSql)
    .bind(owner, episodeId, renderId)
    .all<
      Omit<
        EditorialContext["reviewExamples"][number],
        "isCurrentRender" | "isCurrentEpisode"
      > & { isCurrentRender: number; isCurrentEpisode: number }
    >();
  const reviewExamples = examples.results.slice(0, 100).map((e) => ({
    ...e,
    isCurrentRender: !!e.isCurrentRender,
    isCurrentEpisode: !!e.isCurrentEpisode,
  }));
  const receiptRow = await db
    .prepare(
      "SELECT data FROM editorial_receipts WHERE owner=? AND json_extract(data,'$.contextHash')=? ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(owner, contextHash)
    .first<{ data: string }>();
  const lastReceipt: EditorialReceipt | null = receiptRow
    ? JSON.parse(receiptRow.data)
    : null;
  return {
    ...value,
    contextHash,
    reviewExamples,
    coverage: {
      reviewCount: reviewExamples.length,
      explicitReasonCount: reviewExamples.filter(
        (e) => e.reason.trim() || e.note.trim(),
      ).length,
      blankReasonCount: reviewExamples.filter(
        (e) => !e.reason.trim() && !e.note.trim(),
      ).length,
      inferredRules: 0,
      examplesTruncated: examples.results.length > 100,
    },
    lastReceipt,
    loadedStatus: lastReceipt ? "reported_loaded" : "no_receipt",
  };
}
async function validateTargets(
  db: D1Database,
  episodeId: string | null,
  renderId: string | null,
) {
  if (
    episodeId &&
    !(await db
      .prepare(
        "SELECT id FROM episodes WHERE id=? UNION SELECT id FROM episode_workspaces WHERE id=?",
      )
      .bind(episodeId, episodeId)
      .first())
  )
    throw new HttpError(404, "EPISODE_NOT_FOUND", "Episode not found.");
  if (
    renderId &&
    !(await db
      .prepare(
        "SELECT renders.id FROM renders JOIN clips ON clips.id=renders.clip_id WHERE renders.id=? AND clips.episode_id=?",
      )
      .bind(renderId, episodeId)
      .first())
  )
    throw new HttpError(
      404,
      "RENDER_NOT_FOUND",
      "Exact render does not belong to this episode.",
    );
}
async function prior(
  db: D1Database,
  owner: string,
  key: string,
  fp: string,
  table: "editorial_events" | "editorial_receipts",
) {
  const row = await db
    .prepare(
      `SELECT fingerprint,data FROM ${table} WHERE owner=? AND operation_key=?`,
    )
    .bind(owner, key)
    .first<{ fingerprint: string; data: string }>();
  if (row && row.fingerprint !== fp)
    throw new HttpError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "That operation key was already used for different data.",
    );
  return row;
}
export async function mutateEditorial(
  db: D1Database,
  owner: string,
  kind: "profile" | "feedback",
  raw: unknown,
): Promise<EditorialProfile> {
  const input =
    kind === "profile"
      ? editorialProfileSchema.parse(raw)
      : editorialFeedbackSchema.parse(raw);
  const fp = await fingerprint({ kind, input });
  const cached = await prior(
    db,
    owner,
    input.idempotencyKey,
    fp,
    "editorial_events",
  );
  if (cached) return JSON.parse(cached.data);
  const current = await getEditorialProfile(db, owner);
  if (current.version !== input.expectedRevision)
    throw new HttpError(
      409,
      "REVISION_CONFLICT",
      "Editorial context changed. Reload before saving.",
      current.version,
    );
  const next: EditorialProfile = structuredClone(current);
  const now = new Date().toISOString();
  if (kind === "profile") {
    const v = editorialProfileSchema.parse(input);
    if (v.action === "replace") {
      next.rules = v.rules!;
      if (new Set(next.rules.map((r) => r.id)).size !== next.rules.length)
        throw new HttpError(400, "DUPLICATE_RULE", "Rule IDs must be unique.");
      for (const r of next.rules) {
        await validateTargets(db, r.episodeId, r.renderId);
        if (
          r.evidenceIds.some(
            (e) => !current.feedback.some((f) => f.id === e && f.reason.trim()),
          )
        )
          throw new HttpError(
            400,
            "INVALID_EVIDENCE",
            "Rules may cite only recorded explicit feedback.",
          );
      }
    } else if (v.action === "undo") {
      const old = await atVersion(db, owner, v.undoVersion!);
      next.rules = old.rules;
      next.enabled = old.enabled;
    } else next.enabled = v.action === "enable";
  } else {
    const v = editorialFeedbackSchema.parse(input);
    await validateTargets(db, v.episodeId ?? null, v.renderId ?? null);
    if (v.action === "confirm" || v.action === "dismiss") {
      const p = next.proposals.find(
        (p) => p.id === v.proposalId && p.status === "pending",
      );
      if (!p)
        throw new HttpError(
          409,
          "PROPOSAL_NOT_PENDING",
          "Proposal is no longer pending.",
        );
      if (
        p.rule.scope !== v.scope ||
        p.rule.episodeId !== (v.episodeId ?? null) ||
        p.rule.renderId !== (v.renderId ?? null)
      )
        throw new HttpError(
          400,
          "PROPOSAL_SCOPE_MISMATCH",
          "Confirm the original proposal scope.",
        );
      p.status = v.action === "confirm" ? "confirmed" : "dismissed";
      if (v.action === "confirm") next.rules.push(p.rule);
    } else {
      const evidence = {
        id: crypto.randomUUID(),
        decision: v.decision,
        reason: v.reason,
        scope: v.scope,
        episodeId: v.episodeId ?? null,
        renderId: v.renderId ?? null,
        createdAt: now,
      };
      next.feedback.push(evidence);
      if (v.action === "propose")
        next.proposals.push({
          id: crypto.randomUUID(),
          rule: {
            id: crypto.randomUUID(),
            text: v.ruleText!,
            scope: v.scope,
            episodeId: evidence.episodeId,
            renderId: evidence.renderId,
            evidenceIds: [evidence.id],
          },
          status: "pending",
          createdAt: now,
        });
    }
  }
  if (next.rules.length > 100)
    throw new HttpError(
      409,
      "EDITORIAL_RULE_LIMIT",
      "Remove an obsolete rule before confirming another.",
    );
  next.version = current.version + 1;
  next.updatedAt = now;
  // Bound snapshots rather than silently dropping audit evidence.
  if (JSON.stringify(next).length > 500000)
    throw new HttpError(
      409,
      "EDITORIAL_CAPACITY",
      "Editorial history needs archival before more changes.",
    );
  try {
    await db
      .prepare(
        "INSERT INTO editorial_events(id,owner,operation_key,fingerprint,expected_revision,action,reason,scope,data,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        owner,
        input.idempotencyKey,
        fp,
        current.version,
        `${kind}:${input.action}`,
        input.reason,
        input.scope,
        JSON.stringify(next),
        now,
      )
      .run();
  } catch (error) {
    const raced = await prior(
      db,
      owner,
      input.idempotencyKey,
      fp,
      "editorial_events",
    );
    if (raced) return JSON.parse(raced.data);
    const latest = await getEditorialProfile(db, owner);
    if (latest.version !== current.version)
      throw new HttpError(
        409,
        "REVISION_CONFLICT",
        "Editorial context changed. Reload before saving.",
        latest.version,
      );
    throw error;
  }
  return next;
}
export function validateEditorialReceipt(
  context: EditorialContext,
  input: EditorialReceiptInput,
): void {
  const used = context.rules.filter((r) => input.usedRuleIds.includes(r.id));
  const evidence = new Set(used.flatMap((r) => r.evidenceIds));
  if (
    context.contextHash !== input.contextHash ||
    input.usedRuleIds.some((id) => !context.rules.some((r) => r.id === id)) ||
    input.evidenceIds.some((id) => !evidence.has(id)) ||
    new Set(input.usedRuleIds).size !== input.usedRuleIds.length ||
    new Set(input.evidenceIds).size !== input.evidenceIds.length
  )
    throw new HttpError(
      400,
      "INVALID_CONTEXT_RECEIPT",
      "Receipt must cite the exact loaded context and evidence from used rules.",
    );
  if (
    input.changedBecauseFeedback &&
    (!input.usedRuleIds.length || !input.evidenceIds.length)
  )
    throw new HttpError(
      400,
      "UNSUPPORTED_FEEDBACK_CLAIM",
      "A feedback-driven change requires used rules and their feedback evidence.",
    );
}
export async function recordEditorialReceipt(
  db: D1Database,
  owner: string,
  raw: unknown,
): Promise<EditorialReceipt> {
  const input = editorialReceiptSchema.parse(raw);
  const fp = await fingerprint(input);
  const cached = await prior(
    db,
    owner,
    input.idempotencyKey,
    fp,
    "editorial_receipts",
  );
  if (cached) return JSON.parse(cached.data);
  const context = await getEditorialContext(
    db,
    owner,
    input.episodeId,
    input.renderId ?? null,
    input.profileVersion,
  );
  validateEditorialReceipt(context, input);
  const receipt: EditorialReceipt = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    attestation: "caller_reported",
  };
  try {
    await db
      .prepare(
        "INSERT INTO editorial_receipts(id,owner,operation_key,fingerprint,data,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        receipt.id,
        owner,
        input.idempotencyKey,
        fp,
        JSON.stringify(receipt),
        receipt.createdAt,
      )
      .run();
  } catch (error) {
    const raced = await prior(
      db,
      owner,
      input.idempotencyKey,
      fp,
      "editorial_receipts",
    );
    if (raced) return JSON.parse(raced.data);
    throw error;
  }
  return receipt;
}
export async function listEditorialHistory(db: D1Database, owner: string) {
  const events = await db
    .prepare(
      "SELECT id,action,reason,scope,expected_revision+1 AS version,created_at AS createdAt FROM editorial_events WHERE owner=? ORDER BY expected_revision DESC LIMIT 100",
    )
    .bind(owner)
    .all();
  const receipts = await db
    .prepare(
      "SELECT data FROM editorial_receipts WHERE owner=? ORDER BY created_at DESC,id LIMIT 100",
    )
    .bind(owner)
    .all<{ data: string }>();
  return {
    events: events.results,
    receipts: receipts.results.map(
      (r) => JSON.parse(r.data) as EditorialReceipt,
    ),
  };
}
