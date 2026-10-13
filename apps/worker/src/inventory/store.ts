import { HttpError } from "../errors";
import {
  INVENTORY_STATUSES,
  type InventoryResponse,
  type InventoryStatus,
} from "../../../../packages/shared/src/inventory";
import {
  INVENTORY_SOURCE,
  inventoryEpisodeId,
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
// The human-readable selector names the separately registered pilot scope. It
// never infers an association with the current curated dashboard workspace.
export async function inventoryEpisodeSelection(params: URLSearchParams) {
  for (const name of ["episodeId", "episodeNumber", "after", "status", "q"])
    if (params.getAll(name).length > 1)
      throw new HttpError(
        422,
        "INVENTORY_PARAMETER_INVALID",
        "Inventory parameters must be supplied once.",
      );
  const rawNumber = params.get("episodeNumber");
  const rawId = params.get("episodeId");
  if (rawNumber === null)
    return { episodeId: inventoryEpisodeParameter(rawId), episodeNumber: null };
  if (!/^[1-9][0-9]{0,5}$/.test(rawNumber))
    throw new HttpError(
      422,
      "INVENTORY_EPISODE_INVALID",
      "Choose an exact inventory episode number.",
    );
  const episodeNumber = Number(rawNumber);
  if (episodeNumber !== 127)
    throw new HttpError(
      404,
      "INVENTORY_EPISODE_UNMAPPED",
      "This episode has no registered inventory scope.",
    );
  const episodeId = await inventoryEpisodeId(episodeNumber);
  if (rawId !== null && inventoryEpisodeParameter(rawId) !== episodeId)
    throw new HttpError(
      422,
      "INVENTORY_EPISODE_MISMATCH",
      "The inventory episode selectors do not match.",
    );
  return { episodeId, episodeNumber };
}

interface InventoryListOptions {
  status?: string | null;
  query?: string | null;
  episodeNumber?: number | null;
  ingestionEnabled?: boolean;
}

// The index seeks the greatest durable sequence for each retained identity.
// Snapshot absence never removes an item, and source clocks never order it.
const latestItemsSql = `
  SELECT i.item_id,o.receipt_id,o.observed_ms,o.sequence,o.item_json
  FROM inventory_items i JOIN inventory_observations o
    ON o.source_id=i.source_id AND o.episode_id=i.episode_id AND o.item_id=i.item_id
  WHERE i.source_id=? AND i.episode_id=? AND o.sequence=(
    SELECT sequence FROM inventory_observations newest
    WHERE newest.source_id=i.source_id AND newest.episode_id=i.episode_id
      AND newest.item_id=i.item_id ORDER BY sequence DESC LIMIT 1
  )`;

// All values are bound. INSTR makes %, _ and SQL-shaped text literal searches,
// and deliberately searches reference metadata rather than prose or origins.
const matchesFilterSql = `
  (filters.status IS NULL OR json_extract(latest.item_json,'$.processing_status')=filters.status)
  AND (filters.query='' OR instr(lower(latest.item_id),filters.query)>0
    OR instr(lower(coalesce(json_extract(latest.item_json,'$.media.ref'),'')),filters.query)>0
    OR EXISTS (SELECT 1 FROM json_each(latest.item_json,'$.observations') artifact
      WHERE instr(lower(coalesce(json_extract(artifact.value,'$.artifact'),'')),filters.query)>0)
    OR EXISTS (SELECT 1 FROM json_each(latest.item_json,'$.capture_evidence') evidence
      WHERE instr(lower(coalesce(json_extract(evidence.value,'$.artifact'),'')),filters.query)>0))`;

// Owner-authenticated read only. Never maps producer metadata into playable clips.
export async function listInventory(
  db: D1Database,
  episode: string,
  after: string | null = null,
  options: InventoryListOptions = {},
): Promise<InventoryResponse> {
  inventoryEpisodeParameter(episode);
  if (after !== null && !/^item_[a-f0-9]{64}$/.test(after))
    throw new HttpError(
      422,
      "INVENTORY_CURSOR_INVALID",
      "Invalid inventory cursor.",
    );
  const status = options.status ?? null;
  if (
    status !== null &&
    !INVENTORY_STATUSES.includes(status as InventoryStatus)
  )
    throw new HttpError(
      422,
      "INVENTORY_STATUS_INVALID",
      "Choose a supported inventory status.",
    );
  const rawQuery = options.query ?? "";
  if (rawQuery.length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(rawQuery))
    throw new HttpError(
      422,
      "INVENTORY_QUERY_INVALID",
      "Inventory search must be at most 200 characters without control characters.",
    );
  const query = rawQuery.trim();
  const filterValues = [status, query.toLowerCase()];
  // One small aggregate result, never an application-side load of all items.
  const counts = await db
    .prepare(
      `WITH latest AS (${latestItemsSql}), filters AS (SELECT ? status,? query)
      SELECT json_extract(latest.item_json,'$.processing_status') status,
        COUNT(*) total,SUM(CASE WHEN ${matchesFilterSql} THEN 1 ELSE 0 END) matched
      FROM latest CROSS JOIN filters GROUP BY json_extract(latest.item_json,'$.processing_status')`,
    )
    .bind(INVENTORY_SOURCE, episode, ...filterValues)
    .all<{ status: InventoryStatus; total: number; matched: number }>();
  const statusCounts = Object.fromEntries(
    INVENTORY_STATUSES.map((value) => [value, 0]),
  ) as Record<InventoryStatus, number>;
  let totalItems = 0;
  let matchedItems = 0;
  for (const row of counts.results) {
    statusCounts[row.status] = row.total;
    totalItems += row.total;
    matchedItems += row.matched;
  }
  const rows = await db
    .prepare(
      `WITH latest AS (${latestItemsSql}), filters AS (SELECT ? status,? query)
      SELECT latest.*,s.accepted_at,json_extract(s.receipt_json,'$.complete') receipt_complete,
        json_extract(s.receipt_json,'$.scope') receipt_scope
      FROM latest JOIN inventory_snapshots s ON s.receipt_id=latest.receipt_id CROSS JOIN filters
      WHERE latest.item_id>? AND ${matchesFilterSql} ORDER BY latest.item_id LIMIT 21`,
    )
    .bind(INVENTORY_SOURCE, episode, ...filterValues, after ?? "")
    .all<{
      item_id: string;
      receipt_id: string;
      observed_ms: number;
      sequence: number;
      item_json: string;
      accepted_at: string;
      receipt_complete: number;
      receipt_scope: string;
    }>();
  const page = rows.results.slice(0, 20);
  const items: InventoryResponse["items"] = page.map((row) => ({
    id: row.item_id,
    readiness: "not_evaluated",
    // Unique source/episode sequence and receipt/item keys ensure one latest row.
    conflictingLatestObservations: false,
    variantsTruncated: false,
    variants: [
      {
        receiptId: row.receipt_id,
        sequence: row.sequence,
        observedAt: new Date(row.observed_ms).toISOString(),
        receivedAt: row.accepted_at,
        receiptComplete: row.receipt_complete === 1,
        receiptScope: row.receipt_scope,
        item: JSON.parse(row.item_json) as InventoryItem,
      },
    ],
  }));
  const snapshots = await db
    .prepare(
      "SELECT receipt_json,observed_ms,json_extract(manifest_json,'$.scan_finished_at') scan_finished_at,json_extract(manifest_json,'$.episode.number') episode_number FROM inventory_snapshots WHERE source_id=? AND episode_id=? ORDER BY sequence DESC,receipt_id LIMIT 20",
    )
    .bind(INVENTORY_SOURCE, episode)
    .all<{
      receipt_json: string;
      observed_ms: number;
      scan_finished_at: string;
      episode_number: number;
    }>();
  const recentReceipts = snapshots.results.map((row) => ({
    ...(JSON.parse(row.receipt_json) as InventoryReceipt),
    observedAt: new Date(row.observed_ms).toISOString(),
    scanFinishedAt: row.scan_finished_at,
  }));
  const arrival = await db
    .prepare(
      "SELECT MAX(accepted_at) accepted_at FROM inventory_snapshots WHERE source_id=? AND episode_id=?",
    )
    .bind(INVENTORY_SOURCE, episode)
    .first<{ accepted_at: string | null }>();
  const ingestionEnabled = options.ingestionEnabled === true;
  return {
    sourceId: INVENTORY_SOURCE,
    episodeId: episode,
    episodeNumber:
      options.episodeNumber ?? snapshots.results[0]?.episode_number ?? null,
    candidateCoverage: "partial",
    ingestion: ingestionEnabled ? "enabled" : "disabled",
    ingestionPaused: !ingestionEnabled,
    identityCaveat:
      "Media IDs change on rename; redacted candidate URLs can merge identities.",
    filters: { status: status as InventoryStatus | null, query },
    summary: { totalItems, matchedItems, statusCounts },
    latestReceivedAt: arrival?.accepted_at ?? null,
    latestObservedAt: recentReceipts[0]?.observedAt ?? null,
    latestReceipt: recentReceipts[0] ?? null,
    items,
    recentReceipts,
    nextCursor: rows.results.length > 20 ? page.at(-1)!.item_id : null,
  };
}
