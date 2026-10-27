import { HttpError } from "../errors";
import { INVENTORY_SOURCE } from "./contract";

// A negative-only source snapshot never changes identities or historical rows.
// Only a later observation of this item can restore its freshness.
export const SOURCE_PROOF_UNAVAILABLE = "native_proof_unavailable";
export function positiveSourceObservationSql(alias = "o") {
  return `(json_extract(${alias}.item_json,'$.media.present')=1 AND json_extract(${alias}.item_json,'$.producer_record') IS NOT NULL AND json_extract(${alias}.item_json,'$.processing_status') IN ('captured_observed','unverified'))`;
}
export function sourceProofCurrentSql(alias = "o") {
  return `NOT EXISTS(SELECT 1 FROM inventory_snapshots proof WHERE proof.source_id=${alias}.source_id AND proof.episode_id=${alias}.episode_id AND (proof.sequence>=${alias}.sequence OR NOT ${positiveSourceObservationSql(alias)}) AND EXISTS(SELECT 1 FROM json_each(proof.manifest_json,'$.warnings') warning WHERE warning.value='${SOURCE_PROOF_UNAVAILABLE}'))`;
}
export async function assertSourceProofCurrent(
  db: D1Database,
  episode: string,
  itemId: string,
) {
  const unavailable = await db
    .prepare(
      `SELECT 1 FROM inventory_observations o WHERE o.source_id=? AND o.episode_id=? AND o.item_id=? AND o.sequence=(SELECT max(n.sequence) FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id) AND NOT (${sourceProofCurrentSql()})`,
    )
    .bind(INVENTORY_SOURCE, episode, itemId)
    .first();
  if (unavailable)
    throw new HttpError(
      409,
      "INVENTORY_SOURCE_PROOF_UNAVAILABLE",
      "Source proof is unavailable. Saved decisions and notes are retained; fresh verification is required before acting.",
    );
}
// Claims must also stop when an invalidation arrives after enqueue. A stream
// without invalidations retains its existing claim behavior.
export function jobSourceProofCurrentSql() {
  return `(coalesce(json_extract(capture_jobs.request_json,'$.kind'),'capture')='capture' OR NOT EXISTS(SELECT 1 FROM inventory_snapshots proof WHERE proof.source_id='${INVENTORY_SOURCE}' AND json_extract(proof.manifest_json,'$.episode.number')=json_extract(capture_jobs.request_json,'$.episode') AND EXISTS(SELECT 1 FROM json_each(proof.manifest_json,'$.warnings') warning WHERE warning.value='${SOURCE_PROOF_UNAVAILABLE}') AND NOT EXISTS(SELECT 1 FROM inventory_observations o WHERE o.source_id=proof.source_id AND o.episode_id=proof.episode_id AND o.item_id=json_extract(capture_jobs.request_json,'$.parent.item_id') AND o.sequence>proof.sequence AND o.sequence=(SELECT max(n.sequence) FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id) AND ${positiveSourceObservationSql()} AND json_extract(o.item_json,'$.media.ref')=json_extract(capture_jobs.request_json,'$.parent.ref') AND json_extract(o.item_json,'$.media.size_bytes')=json_extract(capture_jobs.request_json,'$.parent.size_bytes') AND (json_extract(capture_jobs.request_json,'$.parent.clip_id') IS NULL OR json_extract(o.item_json,'$.producer_record.clip_id')=json_extract(capture_jobs.request_json,'$.parent.clip_id')) AND (json_extract(capture_jobs.request_json,'$.parent.clip_uid') IS NULL OR json_extract(o.item_json,'$.producer_record.clip_uid')=json_extract(capture_jobs.request_json,'$.parent.clip_uid')) AND EXISTS(SELECT 1 FROM json_each(o.item_json,'$.capture_evidence') evidence WHERE json_extract(evidence.value,'$.matches_observed_size')=1 AND json_extract(evidence.value,'$.producer_sha256')=json_extract(capture_jobs.request_json,'$.parent.sha256')))))`;
}
