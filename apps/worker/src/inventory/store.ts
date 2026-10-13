import {
  inventoryVersion,
  reviewView,
  versionBasisSql,
  type ReviewRow,
} from "./review";
import { HttpError } from "../errors";
import {
  INVENTORY_STATUSES,
  INVENTORY_GROUPS,
  type InventoryGroup,
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
  for (const name of [
    "episodeId",
    "episodeNumber",
    "after",
    "group",
    "status",
    "q",
    "sort",
    "direction",
    "review",
    "groupFolders",
  ])
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
  group?: string | null;
  status?: string | null;
  query?: string | null;
  episodeNumber?: number | null;
  ingestionEnabled?: boolean;
  sort?: string | null;
  direction?: string | null;
  review?: string | null;
  groupFolders?: boolean;
}

// The index seeks the greatest durable sequence for each retained identity.
// Snapshot absence never removes an item, and source clocks never order it.
const latestItemsSql = `
  SELECT i.item_id,o.receipt_id,o.observed_ms,o.sequence,o.item_json,
    (SELECT min(old.observed_ms) FROM inventory_observations old WHERE old.source_id=i.source_id AND old.episode_id=i.episode_id AND old.item_id=i.item_id AND old.sequence<=(SELECT watermark FROM limits)) first_observed_ms,
    (SELECT min(s.accepted_at) FROM inventory_observations old JOIN inventory_snapshots s ON s.receipt_id=old.receipt_id WHERE old.source_id=i.source_id AND old.episode_id=i.episode_id AND old.item_id=i.item_id AND old.sequence<=(SELECT watermark FROM limits)) first_received_at
  FROM inventory_items i JOIN inventory_observations o
    ON o.source_id=i.source_id AND o.episode_id=i.episode_id AND o.item_id=i.item_id
  WHERE i.source_id=? AND i.episode_id=? AND o.sequence<=(SELECT watermark FROM limits) AND o.sequence=(
    SELECT sequence FROM inventory_observations newest
    WHERE newest.source_id=i.source_id AND newest.episode_id=i.episode_id
      AND newest.item_id=i.item_id AND newest.sequence<=(SELECT watermark FROM limits) ORDER BY sequence DESC LIMIT 1
  )`;

// These are browsing groups, never playable/readiness assertions. Completed
// WebM remains visible as media; incomplete suffixes and unknown formats need
// attention. Candidates are research metadata rather than audio/video files.
const groupedLatestItemsSql = `
  SELECT retained.*,CASE
    WHEN json_extract(retained.item_json,'$.kind')='media'
      AND json_extract(retained.item_json,'$.processing_status')='captured_observed'
      AND json_extract(retained.item_json,'$.media.present')=1
      AND (substr(lower(coalesce(json_extract(retained.item_json,'$.media.ref'),'')),-4)
        IN ('.mp4','.m4v','.mov','.mkv','.avi','.mp3','.m4a','.aac','.wav','.ogg')
        OR substr(lower(coalesce(json_extract(retained.item_json,'$.media.ref'),'')),-5)
        IN ('.webm','.flac','.opus','.aiff')) THEN 'media'
    WHEN json_extract(retained.item_json,'$.kind')='candidate'
      AND json_extract(retained.item_json,'$.processing_status')='candidate' THEN 'research'
    ELSE 'attention' END item_group
  FROM (${latestItemsSql}) retained`;

const refSql = "coalesce(json_extract(g.item_json,'$.media.ref'),'')";
const baseSql = `substr(${refSql},length(rtrim(${refSql},replace(${refSql},'/','')))+1)`;
const namedLatestItemsSql = `SELECT g.*,${refSql} media_ref,${baseSql} filename,
  CASE WHEN instr(${refSql},'/')>0 THEN substr(${refSql},1,length(${refSql})-length(${baseSql})-1) ELSE '' END folder,
  coalesce(CAST(round((julianday(json_extract(g.item_json,'$.producer_record.first_seen_at'))-2440587.5)*86400000) AS INTEGER),g.first_observed_ms) first_seen_ms,
  ${versionBasisSql("g")} version_basis,
  sum(CASE WHEN json_extract(g.item_json,'$.media.present')=1 THEN 1 ELSE 0 END) OVER(PARTITION BY coalesce(json_extract(g.item_json,'$.producer_record.clip_uid'),json_extract(g.item_json,'$.producer_record.clip_id'))) producer_count
  FROM (${groupedLatestItemsSql}) g`;
const reviewedLatestItemsSql = `SELECT n.*,
  CASE WHEN r.review_key IS NULL OR r.version_basis<>n.version_basis OR (coalesce(json_extract(n.item_json,'$.producer_record.clip_uid'),json_extract(n.item_json,'$.producer_record.clip_id')) IS NOT NULL AND n.producer_count>1) OR (r.producer_key IS NOT NULL AND coalesce(json_extract(n.item_json,'$.producer_record.clip_uid'),json_extract(n.item_json,'$.producer_record.clip_id')) IS NOT NULL AND r.producer_key<>'number-one:'||coalesce(json_extract(n.item_json,'$.producer_record.clip_uid'),json_extract(n.item_json,'$.producer_record.clip_id'))) THEN 'unreviewed' ELSE r.status END effective_review_status,
  CASE WHEN r.review_key IS NULL THEN NULL ELSE json_object('review_key',r.review_key,'producer_key',r.producer_key,'item_id',r.item_id,'revision',r.revision,'status',r.status,'notes',r.notes,'reason',r.reason,'reviewed_version',r.reviewed_version,'version_basis',r.version_basis,'saved_at',r.saved_at) END review_json,
  CASE WHEN (coalesce(json_extract(n.item_json,'$.producer_record.clip_uid'),json_extract(n.item_json,'$.producer_record.clip_id')) IS NOT NULL AND n.producer_count>1) OR (r.producer_key IS NOT NULL AND coalesce(json_extract(n.item_json,'$.producer_record.clip_uid'),json_extract(n.item_json,'$.producer_record.clip_id')) IS NOT NULL AND r.producer_key<>'number-one:'||coalesce(json_extract(n.item_json,'$.producer_record.clip_uid'),json_extract(n.item_json,'$.producer_record.clip_id'))) THEN 1 ELSE 0 END identity_conflict
  FROM (${namedLatestItemsSql}) n LEFT JOIN inventory_reviews r
  ON r.source_id=? AND r.episode_id=? AND r.review_key=(SELECT review_key FROM inventory_reviews candidate WHERE candidate.source_id=r.source_id AND candidate.episode_id=r.episode_id AND (candidate.item_id=n.item_id OR candidate.producer_key='number-one:'||coalesce(json_extract(n.item_json,'$.producer_record.clip_uid'),json_extract(n.item_json,'$.producer_record.clip_id'))) ORDER BY CASE WHEN candidate.item_id=n.item_id THEN 0 ELSE 1 END LIMIT 1)`;

// All values are bound. INSTR makes %, _ and SQL-shaped text literal searches,
// and deliberately searches reference metadata rather than prose or origins.
const matchesFilterSql = `
  (filters.group_name='all' OR latest.item_group=filters.group_name)
  AND (filters.review_name='all' OR latest.effective_review_status=filters.review_name)
  AND (filters.status IS NULL OR json_extract(latest.item_json,'$.processing_status')=filters.status)
  AND (filters.query='' OR instr(lower(latest.item_id),filters.query)>0
    OR instr(lower(coalesce(json_extract(latest.item_json,'$.media.ref'),'')),filters.query)>0
    OR EXISTS (SELECT 1 FROM json_each(latest.item_json,'$.observations') artifact
      WHERE instr(lower(coalesce(json_extract(artifact.value,'$.artifact'),'')),filters.query)>0)
    OR EXISTS (SELECT 1 FROM json_each(latest.item_json,'$.capture_evidence') evidence
      WHERE instr(lower(coalesce(json_extract(evidence.value,'$.artifact'),'')),filters.query)>0))`;

// Owner-authenticated read only. Never maps producer metadata into playable clips.
interface InventoryCursor {
  v: 1;
  context: string;
  watermark: number;
  id: string;
  key: string | number | null;
  folder: string;
}
function cursorEncode(cursor: InventoryCursor) {
  return (
    "v1." +
    btoa(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")
  );
}
function cursorDecode(value: string): InventoryCursor {
  try {
    if (value.length > 6000 || !/^v1\.[A-Za-z0-9_-]+$/.test(value))
      throw Error();
    const text = value.slice(3).replaceAll("-", "+").replaceAll("_", "/");
    const c = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0)),
      ),
    ) as InventoryCursor;
    if (
      c.v !== 1 ||
      typeof c.context !== "string" ||
      !Number.isSafeInteger(c.watermark) ||
      c.watermark < 0 ||
      !/^item_[a-f0-9]{64}$/.test(c.id) ||
      typeof c.folder !== "string" ||
      (!["string", "number"].includes(typeof c.key) && c.key !== null) ||
      (typeof c.key === "number" && !Number.isFinite(c.key))
    )
      throw Error();
    return c;
  } catch {
    throw new HttpError(
      422,
      "INVENTORY_CURSOR_INVALID",
      "Invalid inventory cursor.",
    );
  }
}

export async function listInventory(
  db: D1Database,
  episode: string,
  after: string | null = null,
  options: InventoryListOptions = {},
): Promise<InventoryResponse> {
  inventoryEpisodeParameter(episode);
  const group = options.group ?? "all",
    status = options.status ?? null,
    rawQuery = options.query ?? "";
  if (!INVENTORY_GROUPS.includes(group as InventoryGroup))
    throw new HttpError(
      422,
      "INVENTORY_GROUP_INVALID",
      "Choose a supported inventory group.",
    );
  if (
    status !== null &&
    !INVENTORY_STATUSES.includes(status as InventoryStatus)
  )
    throw new HttpError(
      422,
      "INVENTORY_STATUS_INVALID",
      "Choose a supported inventory status.",
    );
  if (rawQuery.length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(rawQuery))
    throw new HttpError(
      422,
      "INVENTORY_QUERY_INVALID",
      "Inventory search must be at most 200 characters without control characters.",
    );
  const query = rawQuery.trim(),
    sort = options.sort ?? "identity",
    direction = options.direction ?? "asc",
    review = options.review ?? "all",
    groupFolders = options.groupFolders === true;
  if (
    !["identity", "filename", "first_observed"].includes(sort) ||
    !["asc", "desc"].includes(direction) ||
    !["all", "unreviewed", "approved", "rejected", "cut_down"].includes(review)
  )
    throw new HttpError(
      422,
      "INVENTORY_SORT_INVALID",
      "Choose a supported sort and review filter.",
    );
  const context = JSON.stringify([
    episode,
    group,
    status,
    query,
    sort,
    direction,
    review,
    groupFolders,
  ]);
  const legacy = after !== null && /^item_[a-f0-9]{64}$/.test(after);
  if (
    legacy &&
    (sort !== "identity" ||
      direction !== "asc" ||
      review !== "all" ||
      groupFolders)
  )
    throw new HttpError(
      422,
      "INVENTORY_CURSOR_INVALID",
      "Refresh pagination after changing the view.",
    );
  const cursor = after !== null && !legacy ? cursorDecode(after) : null;
  if (cursor && cursor.context !== context)
    throw new HttpError(
      422,
      "INVENTORY_CURSOR_INVALID",
      "Refresh pagination after changing the view.",
    );
  const maximum = await db
    .prepare(
      "SELECT coalesce(max(sequence),0) watermark FROM inventory_snapshots WHERE source_id=? AND episode_id=?",
    )
    .bind(INVENTORY_SOURCE, episode)
    .first<{ watermark: number }>();
  const watermark = cursor?.watermark ?? maximum?.watermark ?? 0;
  const filters = [group, status, query.toLowerCase(), review];
  const base = `WITH limits AS (SELECT ? watermark), latest AS (${reviewedLatestItemsSql}), filters AS (SELECT ? group_name,? status,? query,? review_name)`;
  const values = [
    watermark,
    INVENTORY_SOURCE,
    episode,
    INVENTORY_SOURCE,
    episode,
    ...filters,
  ];
  const counts = await db
    .prepare(
      `${base} SELECT json_extract(latest.item_json,'$.processing_status') status, latest.item_group group_name,COUNT(*) total,SUM(CASE WHEN ${matchesFilterSql} THEN 1 ELSE 0 END) matched FROM latest CROSS JOIN filters GROUP BY json_extract(latest.item_json,'$.processing_status'),latest.item_group`,
    )
    .bind(...values)
    .all<{
      status: InventoryStatus;
      group_name: Exclude<InventoryGroup, "all">;
      total: number;
      matched: number;
    }>();
  const statusCounts = Object.fromEntries(
    INVENTORY_STATUSES.map((v) => [v, 0]),
  ) as Record<InventoryStatus, number>;
  const groupCounts: Record<InventoryGroup, number> = {
    all: 0,
    media: 0,
    research: 0,
    attention: 0,
  };
  let totalItems = 0,
    matchedItems = 0;
  for (const row of counts.results) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + row.total;
    groupCounts[row.group_name] += row.total;
    groupCounts.all += row.total;
    totalItems += row.total;
    matchedItems += row.matched;
  }
  const keySql =
    sort === "filename"
      ? "CASE WHEN media_ref='' THEN NULL ELSE lower(filename) END"
      : sort === "first_observed"
        ? "first_seen_ms"
        : "item_id";
  const folderSql = groupFolders ? "folder" : "''";
  const comparison = direction === "asc" ? ">" : "<",
    order = direction === "asc" ? "ASC" : "DESC";
  let seek = "1=1",
    seekValues: (string | number | null)[] = [];
  if (legacy) {
    seek = "item_id>?";
    seekValues = [after];
  } else if (cursor) {
    const nullRank = cursor.key === null ? 1 : 0;
    seek = `(folder_key>? OR (folder_key=? AND ((sort_key IS NULL)>? OR ((sort_key IS NULL)=? AND ((? IS NOT NULL AND sort_key ${comparison} ?) OR ((sort_key IS ? OR sort_key=?) AND item_id ${comparison} ?))))))`;
    seekValues = [
      cursor.folder,
      cursor.folder,
      nullRank,
      nullRank,
      cursor.key,
      cursor.key,
      cursor.key,
      cursor.key,
      cursor.id,
    ];
  }
  const rows = await db
    .prepare(
      `${base}, ordered AS (SELECT latest.*,${keySql} sort_key,${folderSql} folder_key FROM latest CROSS JOIN filters WHERE ${matchesFilterSql}) SELECT ordered.*,s.accepted_at,json_extract(s.receipt_json,'$.complete') receipt_complete,json_extract(s.receipt_json,'$.scope') receipt_scope FROM ordered JOIN inventory_snapshots s ON s.receipt_id=ordered.receipt_id WHERE ${seek} ORDER BY folder_key ASC,(sort_key IS NULL) ASC,sort_key ${order},item_id ${order} LIMIT 21`,
    )
    .bind(...values, ...seekValues)
    .all<{
      item_id: string;
      receipt_id: string;
      observed_ms: number;
      sequence: number;
      item_json: string;
      accepted_at: string;
      receipt_complete: number;
      receipt_scope: string;
      filename: string;
      folder: string;
      first_seen_ms: number | null;
      first_received_at: string | null;
      review_json: string | null;
      identity_conflict: number;
      sort_key: string | number | null;
      folder_key: string;
    }>();
  const page = rows.results.slice(0, 20);
  const items = await Promise.all(
    page.map(async (row) => {
      const item = JSON.parse(row.item_json) as InventoryItem;
      const version = await inventoryVersion(item);
      const saved = row.review_json
        ? (JSON.parse(row.review_json) as ReviewRow)
        : null;
      const state = reviewView(saved, version);
      if (row.identity_conflict) {
        state.effectiveStatus = "unreviewed";
        state.changed = true;
      }
      return {
        id: row.item_id,
        readiness: "not_evaluated" as const,
        conflictingLatestObservations: false,
        variantsTruncated: false,
        folder: row.folder,
        filename: row.filename,
        firstObservedAt:
          row.first_seen_ms === null
            ? null
            : new Date(row.first_seen_ms).toISOString(),
        firstReceivedAt: row.first_received_at,
        producerRecord: item.producer_record,
        review: state,
        identityConflict: row.identity_conflict === 1,
        variants: [
          {
            receiptId: row.receipt_id,
            sequence: row.sequence,
            observedAt: new Date(row.observed_ms).toISOString(),
            receivedAt: row.accepted_at,
            receiptComplete: row.receipt_complete === 1,
            receiptScope: row.receipt_scope,
            item,
          },
        ],
      };
    }),
  );
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
  const last = page.at(-1);
  return {
    sourceId: INVENTORY_SOURCE,
    episodeId: episode,
    episodeNumber:
      options.episodeNumber ?? snapshots.results[0]?.episode_number ?? null,
    candidateCoverage: "partial",
    ingestion: ingestionEnabled ? "enabled" : "disabled",
    ingestionPaused: !ingestionEnabled,
    identityCaveat:
      "Existing producer IDs are reused when supplied. Legacy media IDs change on rename; metadata versions are not independent content verification.",
    filters: {
      group: group as InventoryGroup,
      status: status as InventoryStatus | null,
      query,
      ...(options.sort !== undefined && options.sort !== null
        ? {
            sort: sort as "identity" | "filename" | "first_observed",
            direction: direction as "asc" | "desc",
            review: review as
              "all" | "unreviewed" | "approved" | "rejected" | "cut_down",
          }
        : {}),
    },
    summary: { totalItems, matchedItems, statusCounts, groupCounts },
    latestReceivedAt: arrival?.accepted_at ?? null,
    latestObservedAt: recentReceipts[0]?.observedAt ?? null,
    latestReceipt: recentReceipts[0] ?? null,
    items,
    recentReceipts,
    nextCursor:
      rows.results.length > 20 && last
        ? sort === "identity" &&
          direction === "asc" &&
          review === "all" &&
          !groupFolders
          ? last.item_id
          : cursorEncode({
              v: 1,
              context,
              watermark,
              id: last.item_id,
              key: last.sort_key,
              folder: last.folder_key,
            })
        : null,
  };
}
