import type {
  Episode,
  EpisodeDetail,
  Clip,
  Render,
  ProducerEvent,
  Production,
  ReviewInput,
  VisibilityInput,
  Review,
} from "@twib/shared";
import { HttpError } from "./errors";
import { workspaceEpisodes } from "./workspaces";
interface Row {
  id: string;
  catalog_revision: number;
  catalog_version: number;
  data: string;
  revision: number;
  decision: Review["decision"];
  note: string;
  reason: string;
  updated_at: string | null;
  visibility: Clip["visibility"];
  active_attempt_id: string | null;
}
export function projectProduction(
  events: ProducerEvent[],
  attemptId: string | null,
  now = Date.now(),
): Production {
  const active = events
    .filter((e) => e.attemptId === attemptId)
    .sort((a, b) => a.sequence - b.sequence);
  const last = active.at(-1);
  const progress = active.filter((e) => e.progress).at(-1);
  return {
    attemptId,
    state: last?.state ?? "unknown",
    stage: last?.stage ?? "No producer events",
    lastEventAt: last?.occurredAt ?? null,
    lastProgressAt: progress?.occurredAt ?? null,
    nextExpectedAt: last?.nextExpectedAt ?? null,
    blocker: last?.blocker ?? null,
    checkpoint: last?.checkpoint ?? null,
    stale:
      !!last?.nextExpectedAt &&
      Date.parse(last.nextExpectedAt) < now &&
      !["ready", "failed", "cancelled"].includes(last.state),
  };
}
export async function events(
  db: D1Database,
  attemptId?: string,
): Promise<ProducerEvent[]> {
  const r = await db
    .prepare(
      attemptId
        ? "SELECT data FROM producer_events WHERE attempt_id=? ORDER BY sequence"
        : "SELECT data FROM producer_events ORDER BY sequence",
    )
    .bind(...(attemptId ? [attemptId] : []))
    .all<{ data: string }>();
  return r.results.map((v) => JSON.parse(v.data));
}
function review(row: Row): Review {
  return {
    decision: row.decision,
    revision: row.revision,
    note: row.note,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}
export async function getRender(db: D1Database, id: string): Promise<Render> {
  const row = await db
    .prepare("SELECT * FROM renders WHERE id=?")
    .bind(id)
    .first<Row>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Render not found.");
  const artifact = await db
    .prepare(
      "SELECT render_id FROM artifacts WHERE render_id=? AND kind='original'",
    )
    .bind(id)
    .first();
  const original = await db
    .prepare(
      "SELECT file_id FROM artifacts WHERE render_id=? AND kind='original'",
    )
    .bind(id)
    .first<{ file_id: string }>();
  const proxy = await db
    .prepare("SELECT file_id FROM artifacts WHERE render_id=? AND kind='proxy'")
    .bind(id)
    .first();
  return {
    ...JSON.parse(row.data),
    review: review(row),
    mediaAvailable: !!artifact,
    proxyAvailable: !!proxy,
    driveUrl: original
      ? `https://drive.google.com/file/d/${encodeURIComponent(original.file_id)}/view`
      : null,
  };
}
export async function listEpisodes(
  db: D1Database,
  owner?: string,
): Promise<Episode[]> {
  return workspaceEpisodes(db, owner);
}
export async function getEpisode(
  db: D1Database,
  id: string,
  owner?: string,
): Promise<EpisodeDetail> {
  const metadata = (await workspaceEpisodes(db, owner, id))[0];
  if (!metadata) throw new HttpError(404, "NOT_FOUND", "Episode not found.");
  const clock = await db
    .prepare(
      "SELECT sync_state.version AS catalog_version,workspace_state.version AS workspace_version,workspace_state.intake_version FROM sync_state CROSS JOIN workspace_state WHERE sync_state.id=1 AND workspace_state.id=1",
    )
    .first<{
      catalog_version: number;
      workspace_version: number;
      intake_version: number;
    }>();
  const rows = await db
    .prepare(
      "SELECT clips.*,sync_state.version AS catalog_version FROM clips CROSS JOIN sync_state WHERE episode_id=? AND sync_state.id=1 ORDER BY clips.id",
    )
    .bind(id)
    .all<Row>();
  const clips = await Promise.all(
    rows.results.map(async (r) => {
      const base = JSON.parse(r.data) as Clip;
      const render = await getRender(db, base.currentRenderId);
      const production = projectProduction(
        r.active_attempt_id ? await events(db, r.active_attempt_id) : [],
        r.active_attempt_id,
      );
      if (
        production.state === "ready" &&
        (!render.mediaAvailable ||
          !render.artifactHash ||
          !render.mappingVerified ||
          !["artifact", "container", "codecs", "duration", "mapping"].every(
            (check) =>
              render.qa.some(
                (q) =>
                  q.check === check &&
                  q.result === "passed" &&
                  q.artifactHash === render.artifactHash,
              ),
          ))
      ) {
        production.state = "unknown";
        production.stage =
          "Producer reported completion; artifact or technical QA verification pending";
      }
      return {
        ...base,
        catalogRevision: r.catalog_revision ?? 0,
        visibility: r.visibility,
        visibilityRevision: r.revision,
        render,
        production,
      };
    }),
  );
  const sync = await db
    .prepare("SELECT * FROM sync_state WHERE id=1")
    .first<{ last_success_at: string | null; last_error: string | null }>();
  return {
    ...metadata,
    clips,
    clipCount: clips.length,
    catalogVersion:
      rows.results[0]?.catalog_version ?? clock?.catalog_version ?? 0,
    intakeVersion: clock?.intake_version ?? 0,
    workspaceVersion: clock?.workspace_version ?? 0,
    observedAt: new Date().toISOString(),
    sync: {
      lastSuccessAt: sync?.last_success_at ?? null,
      lastError: sync?.last_error ?? null,
    },
  };
}
export async function operation(
  db: D1Database,
  key: string,
  owner?: string,
): Promise<{ fingerprint: string; response: string } | null> {
  return db
    .prepare(
      "SELECT fingerprint,response FROM operations LEFT JOIN operation_owners ON operation_owners.operation_id=operations.id WHERE operations.id=? AND (? IS NULL OR operation_owners.owner IS NULL OR operation_owners.owner=?)",
    )
    .bind(key, owner ?? null, owner ?? null)
    .first();
}
export async function fingerprint(value: unknown): Promise<string> {
  const b = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(b), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
export async function mutate(
  db: D1Database,
  kind: "review" | "visibility",
  id: string,
  input: ReviewInput | VisibilityInput,
  owner: string,
): Promise<unknown> {
  const fp = await fingerprint({ kind, id, input, owner });
  const prior = await operation(db, input.idempotencyKey);
  if (prior) {
    if (prior.fingerprint !== fp)
      throw new HttpError(
        409,
        "IDEMPOTENCY_REUSE",
        "This request key belongs to different content.",
      );
    return JSON.parse(prior.response);
  }
  const now = new Date().toISOString();
  const sql =
    kind === "review"
      ? "INSERT INTO review_events SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM renders WHERE id=? AND revision=?)"
      : "INSERT INTO visibility_events SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM clips WHERE id=? AND revision=?)";
  const values =
    kind === "review"
      ? [
          crypto.randomUUID(),
          input.idempotencyKey,
          id,
          input.expectedRevision,
          (input as ReviewInput).decision,
          (input as ReviewInput).note ?? "",
          (input as ReviewInput).reason ?? "",
          owner,
          now,
          fp,
          id,
          input.expectedRevision,
        ]
      : [
          crypto.randomUUID(),
          input.idempotencyKey,
          id,
          input.expectedRevision,
          (input as VisibilityInput).visibility,
          owner,
          now,
          fp,
          id,
          input.expectedRevision,
        ];
  try {
    await db
      .prepare(sql)
      .bind(...values)
      .run();
  } catch {
    const raced = await operation(db, input.idempotencyKey);
    if (!raced)
      throw new HttpError(
        503,
        "SAVE_FAILED",
        "Save could not be confirmed. Reconcile the request before retrying.",
      );
    if (raced.fingerprint !== fp)
      throw new HttpError(
        409,
        "IDEMPOTENCY_REUSE",
        "This request key belongs to different content.",
      );
    return JSON.parse(raced.response);
  }
  const saved = await operation(db, input.idempotencyKey);
  if (saved) {
    if (saved.fingerprint !== fp)
      throw new HttpError(
        409,
        "IDEMPOTENCY_REUSE",
        "This request key belongs to different content.",
      );
    return JSON.parse(saved.response);
  }
  const row = await db
    .prepare(
      `SELECT revision FROM ${kind === "review" ? "renders" : "clips"} WHERE id=?`,
    )
    .bind(id)
    .first<{ revision: number }>();
  if (!row)
    throw new HttpError(404, "NOT_FOUND", "The requested record is missing.");
  throw new HttpError(
    409,
    "REVISION_CONFLICT",
    "A newer change was saved. Refresh and review before retrying.",
    row.revision,
  );
}
