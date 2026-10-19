import type { InventoryReadItem } from "@twib/shared";
import { INVENTORY_SOURCE, type InventoryItem } from "./contract";

// Resolve only current, same-episode observations. No path/hash-based identity merge.
const current = `source_id=? AND episode_id=? AND sequence=(SELECT max(n.sequence) FROM inventory_observations n WHERE n.source_id=o.source_id AND n.episode_id=o.episode_id AND n.item_id=o.item_id)`;
export async function manualDerivativeRelations(
  db: D1Database,
  episode: string,
  item: InventoryItem,
): Promise<
  Pick<InventoryReadItem, "manualDerivativeParent" | "manualDerivativeSource">
> {
  const producer = item.producer_record;
  if (!producer) return {};
  const child = await db
    .prepare(
      `SELECT 1 FROM inventory_observations o WHERE ${current}
    AND item_id<>? AND json_extract(item_json,'$.media.present')=1
    AND json_extract(item_json,'$.producer_record.manual_derivative.parent_clip_id') IN (?,?) LIMIT 1`,
    )
    .bind(
      INVENTORY_SOURCE,
      episode,
      item.id,
      producer.clip_id,
      producer.clip_uid ?? producer.clip_id,
    )
    .first();
  const result: Pick<
    InventoryReadItem,
    "manualDerivativeParent" | "manualDerivativeSource"
  > = { manualDerivativeSource: !!child };
  const manual = producer.manual_derivative;
  if (!manual) return result;
  const rows = await db
    .prepare(
      `SELECT item_id,item_json FROM inventory_observations o WHERE ${current}
    AND item_id<>? AND json_extract(item_json,'$.media.present')=1
    AND (json_extract(item_json,'$.producer_record.clip_id')=? OR json_extract(item_json,'$.producer_record.clip_uid')=?) LIMIT 2`,
    )
    .bind(
      INVENTORY_SOURCE,
      episode,
      item.id,
      manual.parent_clip_id,
      manual.parent_clip_id,
    )
    .all<{ item_id: string; item_json: string }>();
  if (rows.results.length !== 1)
    return {
      ...result,
      manualDerivativeParent: {
        state: rows.results.length ? "ambiguous" : "missing",
      },
    };
  const parent = JSON.parse(rows.results[0].item_json) as InventoryItem;
  const hashes = [
    ...new Set(
      [
        ...(parent.capture_evidence?.map((e) => e.producer_sha256) ?? []),
        parent.producer_record?.manual_derivative?.derivative_sha256,
      ].filter(Boolean),
    ),
  ];
  if (
    hashes.length > 1 ||
    (hashes.length === 1 && hashes[0] !== manual.source_sha256) ||
    (parent.media?.duration_seconds != null &&
      parent.media.duration_seconds !== manual.source_duration_seconds)
  )
    return { ...result, manualDerivativeParent: { state: "changed" } };
  return {
    ...result,
    manualDerivativeParent: {
      state:
        hashes.length === 1 && parent.media?.duration_seconds != null
          ? "available"
          : "reported",
      itemId: rows.results[0].item_id,
      ref: parent.media!.ref,
    },
  };
}
