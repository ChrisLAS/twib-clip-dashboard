import { HttpError } from "../errors";
import {
  INVENTORY_SOURCE,
  semanticHash,
  validateEnvelope,
  envelopeHash,
  type InventoryGrant,
  type InventoryItem,
} from "./contract";

export interface InventoryReceipt {
  schema: "number-one-inventory-receipt/v2";
  source_id: string;
  episode_id: string;
  digest: string;
  scan_id: string;
  sequence: number;
  receipt_id: string;
  accepted_at: string;
  stored_item_count: number;
  complete: boolean;
  scope: string;
  allow_deletions: false;
  candidate_coverage: "partial";
}
interface StoredReceipt {
  envelope_hash: string;
  receipt_json: string;
}
async function prior(
  db: D1Database,
  source: string,
  episode: string,
  scanId: string,
): Promise<StoredReceipt | null> {
  return db
    .prepare(
      "SELECT envelope_hash, receipt_json FROM inventory_snapshots WHERE source_id=? AND episode_id=? AND scan_id=?",
    )
    .bind(source, episode, scanId)
    .first<StoredReceipt>();
}
function replay(row: StoredReceipt, hash: string): InventoryReceipt {
  if (row.envelope_hash !== hash)
    throw new HttpError(
      409,
      "INVENTORY_SCAN_CONFLICT",
      "This scan ID was already committed with a different immutable envelope.",
    );
  return JSON.parse(row.receipt_json) as InventoryReceipt;
}
// HTTP access requires the disabled-by-default, dedicated machine-auth adapter.
export async function acceptInventory(
  db: D1Database,
  input: unknown,
  idempotencyKey: string | null,
  grant: InventoryGrant | null,
  now = Date.now(),
): Promise<InventoryReceipt> {
  const envelope = await validateEnvelope(input, idempotencyKey, grant, now);
  const manifest = envelope.manifest;
  const hash = await envelopeHash(envelope);
  const contentHash = await semanticHash(manifest);
  const existing = await prior(
    db,
    manifest.source_id,
    manifest.episode.id,
    envelope.scan_id,
  );
  if (existing) return replay(existing, hash);
  const receipt: InventoryReceipt = {
    schema: "number-one-inventory-receipt/v2",
    source_id: manifest.source_id,
    episode_id: manifest.episode.id,
    digest: manifest.idempotency_digest,
    scan_id: envelope.scan_id,
    sequence: envelope.sequence,
    receipt_id: crypto.randomUUID(),
    accepted_at: new Date(now).toISOString(),
    stored_item_count: manifest.items.length,
    complete: manifest.snapshot.complete,
    scope: manifest.snapshot.scope,
    allow_deletions: false,
    candidate_coverage: "partial",
  };
  try {
    // D1 batch is transactional. One bounded JSON row avoids one statement per item.
    await db.batch([
      db
        .prepare(
          "INSERT INTO inventory_snapshots (receipt_id,source_id,episode_id,digest,payload_hash,scan_id,sequence,envelope_hash,observed_ms,accepted_at,manifest_json,receipt_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          receipt.receipt_id,
          manifest.source_id,
          manifest.episode.id,
          manifest.idempotency_digest,
          contentHash,
          envelope.scan_id,
          envelope.sequence,
          hash,
          Date.parse(manifest.observed_at),
          receipt.accepted_at,
          JSON.stringify(manifest),
          JSON.stringify(receipt),
        ),
      db
        .prepare(
          "INSERT OR IGNORE INTO inventory_items (source_id,episode_id,item_id) SELECT s.source_id,s.episode_id,json_extract(j.value,'$.id') FROM inventory_snapshots s,json_each(s.manifest_json,'$.items') j WHERE s.receipt_id=?",
        )
        .bind(receipt.receipt_id),
      db
        .prepare(
          "INSERT INTO inventory_observations (receipt_id,source_id,episode_id,item_id,observed_ms,sequence,item_json) SELECT s.receipt_id,s.source_id,s.episode_id,json_extract(j.value,'$.id'),s.observed_ms,s.sequence,j.value FROM inventory_snapshots s,json_each(s.manifest_json,'$.items') j WHERE s.receipt_id=?",
        )
        .bind(receipt.receipt_id),
    ]);
  } catch (error) {
    // A concurrent winner, or a lost response after commit, is safe to reconcile.
    const winner = await prior(
      db,
      manifest.source_id,
      manifest.episode.id,
      envelope.scan_id,
    );
    if (winner) return replay(winner, hash);
    const digest = await db
      .prepare(
        "SELECT payload_hash FROM inventory_snapshots WHERE source_id=? AND episode_id=? AND digest=? LIMIT 1",
      )
      .bind(
        manifest.source_id,
        manifest.episode.id,
        manifest.idempotency_digest,
      )
      .first<{ payload_hash: string }>();
    if (digest && digest.payload_hash !== contentHash)
      throw new HttpError(
        409,
        "INVENTORY_DIGEST_CONFLICT",
        "This content digest already represents different metadata.",
      );
    const sequence = await db
      .prepare(
        "SELECT scan_id FROM inventory_snapshots WHERE source_id=? AND episode_id=? AND sequence=?",
      )
      .bind(manifest.source_id, manifest.episode.id, envelope.sequence)
      .first();
    if (sequence)
      throw new HttpError(
        409,
        "INVENTORY_SEQUENCE_CONFLICT",
        "This source and episode sequence was already used. Stop and reconcile the durable outbox.",
      );
    throw error;
  }
  // Read durable receipt, rather than acknowledging transient in-memory state.
  const committed = await prior(
    db,
    manifest.source_id,
    manifest.episode.id,
    envelope.scan_id,
  );
  if (!committed)
    throw new HttpError(
      503,
      "INVENTORY_ACK_UNAVAILABLE",
      "No durable inventory receipt could be confirmed. Retry the same snapshot.",
    );
  return replay(committed, hash);
}
export function inventoryEpisodeParameter(value: string | null): string {
  if (!value || !/^episode_[a-f0-9]{64}$/.test(value))
    throw new HttpError(
      422,
      "INVENTORY_EPISODE_REQUIRED",
      "Choose an exact inventory episode ID.",
    );
  return value;
}
// Owner-authenticated read only. Never maps producer metadata into playable clips.
export async function listInventory(
  db: D1Database,
  episode: string,
  after: string | null = null,
) {
  inventoryEpisodeParameter(episode);
  if (after !== null && !/^item_[a-f0-9]{64}$/.test(after))
    throw new HttpError(
      422,
      "INVENTORY_CURSOR_INVALID",
      "Invalid inventory cursor.",
    );
  const identities = await db
    .prepare(
      "SELECT item_id FROM inventory_items WHERE source_id=? AND episode_id=? AND item_id>? ORDER BY item_id LIMIT 21",
    )
    .bind(INVENTORY_SOURCE, episode, after ?? "")
    .all<{ item_id: string }>();
  const page = identities.results.slice(0, 20);
  const items = [];
  for (const identity of page) {
    // Sequence belongs to one durable source/episode writer; source clock is display-only.
    const rows = await db
      .prepare(
        "SELECT receipt_id,observed_ms,sequence,item_json FROM inventory_observations WHERE source_id=? AND episode_id=? AND item_id=? AND sequence=(SELECT MAX(sequence) FROM inventory_observations WHERE source_id=? AND episode_id=? AND item_id=?) ORDER BY receipt_id LIMIT 21",
      )
      .bind(
        INVENTORY_SOURCE,
        episode,
        identity.item_id,
        INVENTORY_SOURCE,
        episode,
        identity.item_id,
      )
      .all<{
        receipt_id: string;
        observed_ms: number;
        sequence: number;
        item_json: string;
      }>();
    items.push({
      id: identity.item_id,
      readiness: "not_evaluated",
      conflictingLatestObservations: rows.results.length > 1,
      variantsTruncated: rows.results.length > 20,
      variants: rows.results.slice(0, 20).map((row) => ({
        receiptId: row.receipt_id,
        sequence: row.sequence,
        observedAt: new Date(row.observed_ms).toISOString(),
        item: JSON.parse(row.item_json) as InventoryItem,
      })),
    });
  }
  const snapshots = await db
    .prepare(
      "SELECT receipt_json FROM inventory_snapshots WHERE source_id=? AND episode_id=? ORDER BY sequence DESC,receipt_id LIMIT 20",
    )
    .bind(INVENTORY_SOURCE, episode)
    .all<{ receipt_json: string }>();
  return {
    sourceId: INVENTORY_SOURCE,
    episodeId: episode,
    candidateCoverage: "partial",
    ingestion: "disabled",
    identityCaveat:
      "Media IDs change on rename; redacted candidate URLs can merge identities.",
    items,
    recentReceipts: snapshots.results.map(
      (row) => JSON.parse(row.receipt_json) as InventoryReceipt,
    ),
    nextCursor: identities.results.length > 20 ? page.at(-1)!.item_id : null,
  };
}
