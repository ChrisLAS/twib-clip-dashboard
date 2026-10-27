import { assertSourceProofCurrent, sourceProofCurrentSql } from "./freshness";
import { cutSpecSchema, preparedCut, cutInsert } from "../capture-jobs/cut";
import { z } from "zod";
import type { InventoryReview, InventoryReviewInput } from "@twib/shared";
import { HttpError } from "../errors";
import {
  INVENTORY_SOURCE,
  inventoryEpisodeId,
  sha256,
  type InventoryItem,
} from "./contract";

const statuses = ["unreviewed", "approved", "rejected", "cut_down"] as const;
const schema = z
  .object({
    operationId: z.string().uuid(),
    episodeNumber: z.number().int().min(1).max(999999),
    itemId: z.string().regex(/^item_[a-f0-9]{64}$/),
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(["note", "decision"]),
    notes: z.string().max(4000),
    status: z.enum(statuses).optional(),
    reason: z.string().max(2000).optional(),
    cutSpec: cutSpecSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.cutSpec && (v.action !== "decision" || v.status !== "cut_down"))
      ctx.addIssue({
        code: "custom",
        message: "Cut instructions require an explicit cut-down decision.",
      });
    if (v.action === "decision" && v.status === undefined)
      ctx.addIssue({ code: "custom", message: "Choose an explicit decision." });
    if (
      v.action === "note" &&
      (v.status !== undefined || v.reason !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Saving a note cannot change a decision.",
      });
  });

export interface ReviewRow {
  review_key: string;
  producer_key: string | null;
  item_id: string;
  revision: number;
  status: InventoryReview["status"];
  notes: string;
  reason: string;
  reviewed_version: string;
  version_basis: string;
  saved_at: string;
}
export function producerKey(item: InventoryItem): string | null {
  // Reuse Number One's existing IDs; no new clip registry or automatic hash merge.
  return item.producer_record
    ? `number-one:${item.producer_record.clip_uid ?? item.producer_record.clip_id}`
    : null;
}
export function inventoryVersionBasis(item: InventoryItem) {
  return JSON.stringify({
    kind: item.kind,
    present: item.media?.present ?? false,
    size: item.media?.size_bytes ?? null,
    modified: item.media?.modified_at ?? null,
    duration: item.media?.duration_seconds ?? null,
    status: item.processing_status,
    hashes: [
      ...new Set(
        [
          ...(item.capture_evidence ?? []).map((e) => e.producer_sha256),
          item.producer_record?.manual_derivative?.derivative_sha256,
        ].filter(Boolean),
      ),
    ].sort(),
  });
}
export async function inventoryVersion(item: InventoryItem) {
  return sha256(inventoryVersionBasis(item));
}
// The same bounded metadata basis permits full-result review filtering in SQL.
// Neither size/mtime nor a producer-declared hash is independent content proof.
export function versionBasisSql(alias: string) {
  const j = `${alias}.item_json`;
  return `json_object('kind',json_extract(${j},'$.kind'),'present',json(CASE WHEN json_extract(${j},'$.media.present')=1 THEN 'true' ELSE 'false' END),
    'size',json_extract(${j},'$.media.size_bytes'),'modified',json_extract(${j},'$.media.modified_at'),
    'duration',json_extract(${j},'$.media.duration_seconds'),'status',json_extract(${j},'$.processing_status'),
    'hashes',json(coalesce((SELECT json_group_array(hash) FROM (SELECT json_extract(e.value,'$.producer_sha256') hash FROM json_each(${j},'$.capture_evidence') e WHERE json_extract(e.value,'$.producer_sha256') IS NOT NULL UNION SELECT json_extract(${j},'$.producer_record.manual_derivative.derivative_sha256') hash WHERE json_extract(${j},'$.producer_record.manual_derivative.derivative_sha256') IS NOT NULL ORDER BY hash)), '[]'))) `;
}
export function reviewView(
  row: ReviewRow | null,
  version: string,
): InventoryReview {
  const changed = !!row && row.reviewed_version !== version;
  return {
    status: row?.status ?? "unreviewed",
    effectiveStatus: changed ? "unreviewed" : (row?.status ?? "unreviewed"),
    notes: row?.notes ?? "",
    reason: row?.reason ?? "",
    revision: row?.revision ?? 0,
    version,
    changed,
    savedAt: row?.saved_at ?? null,
  };
}
export async function reviewFor(
  db: D1Database,
  episode: string,
  item: InventoryItem,
): Promise<ReviewRow | null> {
  await assertSourceProofCurrent(db, episode, item.id);
  const adopted = await db
    .prepare(
      "SELECT coalesce(json_extract(item_json,'$.producer_record.clip_uid'),json_extract(item_json,'$.producer_record.clip_id')) identity FROM inventory_observations WHERE source_id=? AND episode_id=? AND item_id=? AND json_extract(item_json,'$.producer_record') IS NOT NULL ORDER BY sequence LIMIT 1",
    )
    .bind(INVENTORY_SOURCE, episode, item.id)
    .first<{ identity: string }>();
  if (adopted && "number-one:" + adopted.identity !== producerKey(item))
    throw new HttpError(
      409,
      "INVENTORY_REVIEW_IDENTITY_CONFLICT",
      "Previously observed source identity changed or is unavailable. Saved reviews were retained.",
    );
  if (item.producer_record) {
    const duplicate = await db
      .prepare(
        `SELECT 1 FROM inventory_observations o WHERE o.source_id=? AND o.episode_id=? AND o.item_id<>? AND coalesce(json_extract(o.item_json,'$.producer_record.clip_uid'),json_extract(o.item_json,'$.producer_record.clip_id'))=? AND json_extract(o.item_json,'$.media.present')=1 AND o.sequence=(SELECT max(n.sequence) FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id) LIMIT 1`,
      )
      .bind(
        INVENTORY_SOURCE,
        episode,
        item.id,
        item.producer_record.clip_uid ?? item.producer_record.clip_id,
      )
      .first();
    if (duplicate)
      throw new HttpError(
        409,
        "INVENTORY_REVIEW_IDENTITY_CONFLICT",
        "Multiple current files claim this producer identity. Reconcile them before reviewing.",
      );
  }
  const rows = await db
    .prepare(
      "SELECT * FROM inventory_reviews WHERE source_id=? AND episode_id=? AND (item_id=? OR producer_key=?)",
    )
    .bind(INVENTORY_SOURCE, episode, item.id, producerKey(item))
    .all<ReviewRow>();
  if (rows.results.length > 1)
    throw new HttpError(
      409,
      "INVENTORY_REVIEW_IDENTITY_CONFLICT",
      "Existing producer identities need reconciliation; no reviews were merged.",
    );
  const row = rows.results[0] ?? null;
  if (row?.producer_key && row.producer_key !== producerKey(item))
    throw new HttpError(
      409,
      "INVENTORY_REVIEW_IDENTITY_CONFLICT",
      "The existing producer identity changed. No review identities were rebound.",
    );
  return row;
}
export async function saveInventoryReview(
  db: D1Database,
  raw: unknown,
  owner: string,
  now = Date.now(),
) {
  const input = schema.parse(raw) as InventoryReviewInput;
  const requestHash = await sha256(JSON.stringify(input));
  const prior = await db
    .prepare(
      "SELECT owner,request_hash,response_json FROM inventory_review_operations WHERE operation_id=?",
    )
    .bind(input.operationId)
    .first<{ owner: string; request_hash: string; response_json: string }>();
  if (prior) {
    if (prior.owner !== owner || prior.request_hash !== requestHash)
      throw new HttpError(
        409,
        "INVENTORY_REVIEW_OPERATION_CONFLICT",
        "This operation already represents a different review.",
      );
    return JSON.parse(prior.response_json) as InventoryReview;
  }
  const episode = await inventoryEpisodeId(input.episodeNumber);
  const observed = await db
    .prepare(
      "SELECT receipt_id,sequence,item_json FROM inventory_observations WHERE source_id=? AND episode_id=? AND item_id=? ORDER BY sequence DESC LIMIT 1",
    )
    .bind(INVENTORY_SOURCE, episode, input.itemId)
    .first<{ receipt_id: string; sequence: number; item_json: string }>();
  if (!observed)
    throw new HttpError(
      404,
      "INVENTORY_REVIEW_ITEM_MISSING",
      "This inventory record is unavailable.",
    );
  const item = JSON.parse(observed.item_json) as InventoryItem;
  const version = await inventoryVersion(item);
  const row = await reviewFor(db, episode, item);
  if (
    version !== input.expectedVersion ||
    (row?.revision ?? 0) !== input.expectedRevision
  )
    throw new HttpError(
      409,
      "INVENTORY_REVIEW_CHANGED",
      "This record or review changed. Refresh before saving; your draft has not been overwritten.",
    );
  const status =
    input.action === "decision" ? input.status! : (row?.status ?? "unreviewed");
  const reason =
    input.action === "decision"
      ? (input.reason ?? "").trim()
      : (row?.reason ?? "");
  if (
    input.action === "decision" &&
    (status === "rejected" ||
      status === "cut_down" ||
      (status === "approved" &&
        (item.media?.duration_seconds == null ||
          item.media.duration_seconds > 180))) &&
    !reason
  )
    throw new HttpError(
      422,
      "INVENTORY_REVIEW_REASON_REQUIRED",
      "Explain rejection, requested revision, or approval of a long/unknown-duration clip.",
    );
  const key = row?.review_key ?? producerKey(item) ?? item.id;
  const reviewedVersion =
    input.action === "decision" ? version : (row?.reviewed_version ?? version);
  const basis =
    input.action === "decision"
      ? inventoryVersionBasis(item)
      : (row?.version_basis ?? inventoryVersionBasis(item));
  const next: ReviewRow = {
    review_key: key,
    producer_key: producerKey(item) ?? row?.producer_key ?? null,
    item_id: item.id,
    revision: input.expectedRevision + 1,
    status,
    notes: input.notes,
    reason,
    reviewed_version: reviewedVersion,
    version_basis: basis,
    saved_at: new Date(now).toISOString(),
  };
  const cut = preparedCut(input, item, owner, now);
  const response = reviewView(next, version),
    encoded = JSON.stringify({
      ...response,
      ...(cut ? { cutRequestId: cut.id } : {}),
    });
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO inventory_review_operations(operation_id,owner,request_hash,response_json)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM inventory_observations o WHERE o.source_id=? AND o.episode_id=? AND o.item_id=? AND o.receipt_id=? AND o.sequence=? AND ${sourceProofCurrentSql()} AND NOT EXISTS(SELECT 1 FROM inventory_observations newer WHERE newer.source_id=o.source_id AND newer.episode_id=o.episode_id AND newer.item_id=o.item_id AND newer.sequence>o.sequence))
      AND NOT EXISTS(SELECT 1 FROM inventory_observations duplicate WHERE duplicate.source_id=? AND duplicate.episode_id=? AND duplicate.item_id<>? AND coalesce(json_extract(duplicate.item_json,'$.producer_record.clip_uid'),json_extract(duplicate.item_json,'$.producer_record.clip_id'))=? AND json_extract(duplicate.item_json,'$.media.present')=1 AND duplicate.sequence=(SELECT max(latest.sequence) FROM inventory_observations latest WHERE latest.source_id=duplicate.source_id AND latest.episode_id=duplicate.episode_id AND latest.item_id=duplicate.item_id))
      AND coalesce((SELECT revision FROM inventory_reviews WHERE source_id=? AND episode_id=? AND review_key=?),0)=?`,
      )
      .bind(
        input.operationId,
        owner,
        requestHash,
        encoded,
        INVENTORY_SOURCE,
        episode,
        item.id,
        observed.receipt_id,
        observed.sequence,
        INVENTORY_SOURCE,
        episode,
        item.id,
        item.producer_record?.clip_uid ?? item.producer_record?.clip_id ?? null,
        INVENTORY_SOURCE,
        episode,
        key,
        input.expectedRevision,
      ),
    db
      .prepare(
        `INSERT INTO inventory_reviews(source_id,episode_id,review_key,item_id,producer_key,revision,status,notes,reason,reviewed_version,version_basis,saved_at,owner)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM inventory_review_operations WHERE operation_id=? AND owner=? AND request_hash=? AND response_json=?)
      ON CONFLICT(source_id,episode_id,review_key) DO UPDATE SET item_id=excluded.item_id,producer_key=excluded.producer_key,revision=excluded.revision,status=excluded.status,notes=excluded.notes,reason=excluded.reason,reviewed_version=excluded.reviewed_version,version_basis=excluded.version_basis,saved_at=excluded.saved_at,owner=excluded.owner
      WHERE inventory_reviews.revision=?`,
      )
      .bind(
        INVENTORY_SOURCE,
        episode,
        key,
        next.item_id,
        next.producer_key,
        next.revision,
        status,
        next.notes,
        reason,
        reviewedVersion,
        basis,
        next.saved_at,
        owner,
        input.operationId,
        owner,
        requestHash,
        encoded,
        input.expectedRevision,
      ),
    ...(cut ? [cutInsert(db, cut, requestHash, encoded)] : []),
  ]);
  const committed = await db
    .prepare(
      "SELECT response_json FROM inventory_review_operations WHERE operation_id=? AND owner=? AND request_hash=?",
    )
    .bind(input.operationId, owner, requestHash)
    .first<{ response_json: string }>();
  if (!committed)
    throw new HttpError(
      409,
      "INVENTORY_REVIEW_CHANGED",
      "The record changed while saving. Refresh before retrying.",
    );
  return JSON.parse(committed.response_json) as InventoryReview;
}
