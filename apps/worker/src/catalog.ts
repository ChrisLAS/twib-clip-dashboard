import type { CatalogStatus } from "@twib/shared";
import type { Env } from "./env";
import { googleConfigured } from "./google";
import { HttpError } from "./errors";

export const SYNC_INTERVAL_SECONDS = 300;
export const SYNC_DEADLINE_MS = 120_000;
// All external requests end by the earlier deadline. The longer lease leaves
// time for the final database write; every import batch is independently fenced.
export const SYNC_LEASE_MS = 180_000;
export const SYNC_STALE_MS = 15 * 60_000;
export interface SyncState {
  version: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  sheet_hash: string | null;
}
export function catalogConfigured(env: Env): boolean {
  return (
    googleConfigured(env) &&
    !!(
      env.PRODUCER_SHEET_ID &&
      env.PRODUCER_SHEET_RANGE &&
      env.ALLOWED_EPISODE_IDS &&
      env.ALLOWED_DRIVE_FOLDER_IDS
    )
  );
}
export async function catalogStatus(env: Env): Promise<CatalogStatus> {
  // One statement gives status and index the same SQLite snapshot; it reads no
  // Google data, transcript bodies, review notes, or media metadata.
  const row = await env.DB.prepare(
    `SELECT sync_state.*, (SELECT intake_version FROM workspace_state WHERE id=1) AS intake_version, (SELECT version FROM workspace_state WHERE id=1) AS workspace_version, COALESCE((SELECT json_group_array(json_object(
    'id',id,'episodeId',episode_id,'revision',catalog_revision,
    'currentRenderId',json_extract(data,'$.currentRenderId'))) FROM (SELECT id,episode_id,catalog_revision,data FROM clips ORDER BY id LIMIT 1001)),'[]') AS clips
    FROM sync_state WHERE id=1`,
  ).first<
    SyncState & {
      clips: string;
      intake_version: number;
      workspace_version: number;
    }
  >();
  if (!row)
    throw new HttpError(
      503,
      "SYNC_UNAVAILABLE",
      "Catalog status is unavailable.",
    );
  const now = Date.now();
  const running = !!row.lease_owner && (row.lease_expires_at ?? 0) > now;
  const interrupted = !!row.lease_owner && !running;
  const clips = JSON.parse(row.clips) as CatalogStatus["clips"];
  return {
    complete: clips.length <= 1000,
    version: row.version,
    intakeVersion: row.intake_version,
    workspaceVersion: row.workspace_version,
    observedAt: new Date(now).toISOString(),
    sync: {
      configured: catalogConfigured(env),
      running,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      lastError:
        row.last_error ??
        (interrupted
          ? "The previous catalog sync did not finish. The next scheduled check will retry."
          : null),
      stale:
        !row.last_success_at ||
        now - Date.parse(row.last_success_at) > SYNC_STALE_MS,
      intervalSeconds: SYNC_INTERVAL_SECONDS,
    },
    clips: clips.slice(0, 1000),
  };
}
export async function acquireSyncLease(
  db: D1Database,
): Promise<{ owner: string; sheetHash: string | null }> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE sync_state SET lease_owner=?,lease_expires_at=?,last_attempt_at=?
    WHERE id=1 AND (lease_owner IS NULL OR lease_expires_at<=?) RETURNING sheet_hash`,
    )
    .bind(owner, now + SYNC_LEASE_MS, new Date(now).toISOString(), now)
    .first<{ sheet_hash: string | null }>();
  if (!row)
    throw new HttpError(
      409,
      "SYNC_IN_PROGRESS",
      "A catalog sync is already running. Wait for it to finish.",
    );
  return { owner, sheetHash: row.sheet_hash };
}
export function syncFence(db: D1Database, owner: string): D1PreparedStatement {
  // Evaluated by SQLite inside the same atomic batch as catalog changes. A
  // delayed invocation cannot commit after expiration or another owner wins.
  return db
    .prepare(
      `INSERT INTO sync_commit_guard(id,valid) VALUES(1,
    CASE WHEN EXISTS(SELECT 1 FROM sync_state WHERE id=1 AND lease_owner=? AND
      lease_expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) THEN 1 ELSE 0 END)
    ON CONFLICT(id) DO UPDATE SET valid=excluded.valid`,
    )
    .bind(owner);
}
export function checkSyncDeadline(deadline: number): void {
  if (Date.now() >= deadline)
    throw new HttpError(
      503,
      "SYNC_TIMEOUT",
      "Catalog sync timed out. Committed clips are preserved; the next scheduled check will retry.",
    );
}
export async function readBoundedText(
  response: Response,
  limit: number,
): Promise<string> {
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body?.cancel();
    throw new HttpError(
      413,
      "IMPORT_TOO_LARGE",
      "Producer data exceeds the import limit.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(
          413,
          "IMPORT_TOO_LARGE",
          "Producer data exceeds the import limit.",
        );
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
