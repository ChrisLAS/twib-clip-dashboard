import type {
  PublicationAssetKind,
  PublicationAssetStatus,
  PublicationStatus,
  PublishedEdition,
} from "../../../packages/shared/src/publication";
import type { Env } from "./env";
import { HttpError } from "./errors";
import {
  parseChapters,
  parseFeed,
  parseSrt,
  type FeedEpisode,
} from "./publication-parsers";

export interface PublicationEnv extends Env {
  PUBLICATION_FEED_URL?: string;
  PUBLICATION_ALLOWED_HOSTS?: string;
  PUBLICATION_AUTO_ROLLOVER?: string;
}
const HOUR = 3600000;
/** Match the approved :02 UTC cron, avoiding a whole-hour skip from delivery jitter. */
export function nextPublicationCheck(now: number): number {
  return Math.floor(now / HOUR) * HOUR + HOUR + 2 * 60000;
}
const LEASE = 90000;
const DEADLINE = 45000;
interface SyncRow {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_scheduled_success_at: string | null;
  last_error: string | null;
  next_check_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  latest_guid: string | null;
  feed_id: string | null;
}
interface AssetRow {
  asset_key: string;
  kind: PublicationAssetKind;
  url: string;
  state: PublicationAssetStatus["state"];
  checked_at: string | null;
  fetched_at: string | null;
  hash: string | null;
  normalized_hash: string | null;
  etag: string | null;
  last_modified: string | null;
  body: string | null;
  parsed: string | null;
  error: string | null;
  next_retry_at: number;
  failure_count: number;
}
const emptyAsset = (): PublicationAssetStatus => ({
  state: "missing",
  checkedAt: null,
  fetchedAt: null,
  hash: null,
  error: null,
  nextRetryAt: null,
  failureCount: 0,
});
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
/** Exact operator-controlled hostname allowlist; no source-supplied host expansion. */
export function validatePublicationUrl(
  input: string,
  allowedHosts: string[],
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Publication URL is invalid");
  }
  const host = url.hostname.toLowerCase();
  if (
    input.length > 4096 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !host.includes(".") ||
    host.endsWith(".") ||
    host.includes(":") ||
    /^[\d.]+$/.test(host) ||
    /(?:^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host) ||
    !allowedHosts.includes(host)
  )
    throw new Error(
      "Publication URL is outside the trusted public host allowlist",
    );
  url.hash = "";
  return url;
}
function hosts(env: PublicationEnv): string[] {
  return (env.PUBLICATION_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
export function publicationConfigured(env: PublicationEnv): boolean {
  return !!(env.PUBLICATION_FEED_URL && env.PUBLICATION_ALLOWED_HOSTS);
}
function fence(db: D1Database, owner: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO publication_commit_guard(id,valid) VALUES(1,CASE WHEN EXISTS(SELECT 1 FROM publication_sync WHERE id=1 AND lease_owner=? AND lease_expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET valid=excluded.valid`,
    )
    .bind(owner);
}
async function boundedBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Publication asset exceeds size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Publication asset exceeds size limit");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export function publicationRetryAfter(
  value: string | null,
  now = Date.now(),
): number | null {
  if (!value) return null;
  const milliseconds = /^\d+$/.test(value.trim())
    ? now + Number(value.trim()) * 1000
    : Date.parse(value);
  return Number.isFinite(milliseconds) &&
    milliseconds > now &&
    milliseconds <= 8640000000000000
    ? milliseconds
    : null;
}
class FetchProblem extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAt: number | null = null,
  ) {
    super(message);
  }
}
async function fetchPublic(
  url: string,
  allowed: string[],
  cached: AssetRow | null,
  limit: number,
  deadline: number,
): Promise<{
  bytes: Uint8Array | null;
  etag: string | null;
  lastModified: string | null;
}> {
  const controller = new AbortController();
  const remaining = Math.min(12000, deadline - Date.now());
  if (remaining <= 0) throw new Error("Publication sync deadline reached");
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    let target = validatePublicationUrl(url, allowed);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const headers = new Headers({
        Accept:
          "application/rss+xml,application/xml,application/x-subrip,text/plain,application/json,*/*;q=0.1",
      });
      if (cached?.url === url && cached.body !== null) {
        if (cached.etag) headers.set("If-None-Match", cached.etag);
        if (cached.last_modified)
          headers.set("If-Modified-Since", cached.last_modified);
      }
      const response = await fetch(target.toString(), {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3)
          throw new Error("Publication redirect limit or missing location");
        target = validatePublicationUrl(
          new URL(location, target).toString(),
          allowed,
        );
        continue;
      }
      if (response.status === 304) {
        await response.body?.cancel();
        if (!cached?.body || !cached.hash)
          throw new Error("Publication returned 304 without cached content");
        return {
          bytes: null,
          etag: cached.etag,
          lastModified: cached.last_modified,
        };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new FetchProblem(
          response.status,
          response.status === 401 || response.status === 403
            ? "Public source access is blocked (HTTP " +
                response.status +
                "). No credentials or bypass will be attempted."
            : "Public source request failed (HTTP " + response.status + ").",
          publicationRetryAfter(response.headers.get("retry-after")),
        );
      }
      return {
        bytes: await boundedBytes(response, limit),
        etag: response.headers.get("etag")?.slice(0, 1024) ?? null,
        lastModified:
          response.headers.get("last-modified")?.slice(0, 256) ?? null,
      };
    }
    throw new Error("Publication redirect limit");
  } finally {
    clearTimeout(timer);
  }
}
async function asset(
  env: PublicationEnv,
  owner: string,
  key: string,
  kind: PublicationAssetKind,
  url: string | null,
  deadline: number,
): Promise<AssetRow> {
  const old = await env.DB.prepare(
    "SELECT * FROM publication_assets WHERE asset_key=?",
  )
    .bind(key)
    .first<AssetRow>();
  const same = old?.url === (url ?? "") ? old : null;
  if (same && same.next_retry_at > Date.now()) return same;
  let row: AssetRow = same
    ? { ...same }
    : {
        asset_key: key,
        kind,
        url: url ?? "",
        state: "missing",
        checked_at: null,
        fetched_at: null,
        hash: null,
        normalized_hash: null,
        etag: null,
        last_modified: null,
        body: null,
        parsed: null,
        error: null,
        next_retry_at: 0,
        failure_count: 0,
      };
  row.checked_at = new Date().toISOString();
  if (url) {
    try {
      const fetched = await fetchPublic(
        url,
        hosts(env),
        same,
        kind === "chapters" ? 131072 : kind === "rss" ? 1048576 : 524288,
        deadline,
      );
      if (fetched.bytes) {
        const hash = await sha256(fetched.bytes);
        if (hash !== row.hash) {
          const body = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(fetched.bytes);
          const parsed =
            kind === "rss"
              ? parseFeed(body)
              : kind === "transcript"
                ? parseSrt(body)
                : parseChapters(body);
          const serialized = JSON.stringify(parsed);
          row = {
            ...row,
            body,
            parsed: serialized,
            hash,
            normalized_hash: await sha256(serialized),
          };
        }
        row.fetched_at = row.checked_at;
      }
      row = {
        ...row,
        state: "ready",
        error: null,
        next_retry_at: 0,
        failure_count: 0,
        etag: fetched.etag,
        last_modified: fetched.lastModified,
      };
    } catch (error) {
      row.state =
        error instanceof FetchProblem && [401, 403].includes(error.status)
          ? "blocked"
          : "error";
      row.failure_count += 1;
      const backoff =
        error instanceof FetchProblem && [401, 403, 404].includes(error.status)
          ? HOUR
          : Math.min(24 * HOUR, HOUR * 2 ** Math.min(row.failure_count - 1, 5));
      row.next_retry_at = Math.max(
        nextPublicationCheck(Date.now()) + backoff - HOUR,
        error instanceof FetchProblem ? (error.retryAt ?? 0) : 0,
      );
      // Never expose source URLs, response bodies or arbitrary network error text.
      row.error =
        error instanceof FetchProblem
          ? error.message
          : "Publication asset could not be fetched or validated. The next hourly check will retry.";
    }
  }
  await env.DB.batch([
    fence(env.DB, owner),
    ...(row.hash && row.body && row.parsed && row.normalized_hash
      ? [
          env.DB.prepare(
            "INSERT INTO publication_asset_versions(hash,kind,body,parsed,normalized_hash) VALUES(?,?,?,?,?) ON CONFLICT(hash) DO NOTHING",
          ).bind(row.hash, row.kind, row.body, row.parsed, row.normalized_hash),
        ]
      : []),
    env.DB.prepare(
      `INSERT INTO publication_assets(asset_key,kind,url,state,checked_at,fetched_at,hash,normalized_hash,etag,last_modified,body,parsed,error,next_retry_at,failure_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(asset_key) DO UPDATE SET url=excluded.url,state=excluded.state,checked_at=excluded.checked_at,fetched_at=excluded.fetched_at,hash=excluded.hash,normalized_hash=excluded.normalized_hash,etag=excluded.etag,last_modified=excluded.last_modified,body=excluded.body,parsed=excluded.parsed,error=excluded.error,next_retry_at=excluded.next_retry_at,failure_count=excluded.failure_count`,
    ).bind(
      row.asset_key,
      row.kind,
      row.url,
      row.state,
      row.checked_at,
      row.fetched_at,
      row.hash,
      row.normalized_hash,
      row.etag,
      row.last_modified,
      row.body,
      row.parsed,
      row.error,
      row.next_retry_at,
      row.failure_count,
    ),
  ]);
  return row;
}
async function episodeId(
  db: D1Database,
  number: number | null,
): Promise<string | null> {
  if (number === null) return null;
  const rows = await db
    .prepare(
      `SELECT id FROM (SELECT id,coalesce(w.data,e.data) AS data FROM (SELECT id FROM episodes UNION SELECT id FROM episode_workspaces) ids LEFT JOIN episodes e USING(id) LEFT JOIN episode_workspaces w USING(id)) WHERE json_extract(data,'$.number')=? LIMIT 2`,
    )
    .bind(number)
    .all<{ id: string }>();
  return rows.results.length === 1 ? rows.results[0].id : null;
}
async function saveEpisode(
  env: PublicationEnv,
  owner: string,
  feedId: string,
  item: FeedEpisode,
  transcript: AssetRow,
  chapters: AssetRow,
): Promise<void> {
  const mappedId = await episodeId(env.DB, item.episodeNumber);
  const transcriptHash = transcript.hash,
    chaptersHash = chapters.hash;
  const editionFingerprint = await sha256(
    JSON.stringify({
      schema: 1,
      feedId,
      ...item,
      transcriptHash,
      chaptersHash,
    }),
  );
  const data: PublishedEdition = {
    feedId,
    guid: item.guid,
    episodeId: mappedId,
    episodeNumber: item.episodeNumber,
    title: item.title,
    publishedAt: item.publishedAt,
    editionFingerprint,
    transcriptHash,
    transcriptNormalizedHash: transcript.normalized_hash,
    chaptersHash,
    mediaFingerprint: null,
  };
  const statements = [
    fence(env.DB, owner),
    env.DB.prepare(
      "INSERT INTO publication_editions(fingerprint,feed_id,guid,data,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(fingerprint) DO NOTHING",
    ).bind(
      editionFingerprint,
      feedId,
      item.guid,
      JSON.stringify(data),
      new Date().toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO publication_episodes(feed_id,guid,episode_id,transcript_asset_key,data) VALUES(?,?,?,?,?) ON CONFLICT(feed_id,guid) DO UPDATE SET episode_id=excluded.episode_id,transcript_asset_key=excluded.transcript_asset_key,data=excluded.data",
    ).bind(
      feedId,
      item.guid,
      mappedId,
      transcript.asset_key,
      JSON.stringify(data),
    ),
    env.DB.prepare(
      "UPDATE publication_sync SET latest_guid=?,feed_id=? WHERE id=1",
    ).bind(item.guid, feedId),
  ];
  // Opt-in rollover only creates an empty, inactive next draft. The host's active
  // workspace, uploaded media, notes and existing draft title are never changed.
  if (
    env.PUBLICATION_AUTO_ROLLOVER === "true" &&
    mappedId &&
    item.episodeNumber !== null
  ) {
    const next = item.episodeNumber + 1,
      id = "twib-" + next;
    const draft = JSON.stringify({
      id,
      number: next,
      title: "TWiB " + next,
      subtitle: "",
      clipCount: 0,
      publishedGuid: null,
    });
    statements.push(
      env.DB.prepare(
        `INSERT INTO episode_workspaces(id,data,status,is_active) SELECT ?,?,'draft',0 WHERE NOT EXISTS(SELECT 1 FROM episode_workspaces WHERE json_extract(data,'$.number')=?) AND NOT EXISTS(SELECT 1 FROM episodes WHERE json_extract(data,'$.number')=?) ON CONFLICT(id) DO NOTHING`,
      ).bind(id, draft, next, next),
    );
  }
  await env.DB.batch(statements);
}
export async function publicationStatus(
  env: PublicationEnv,
): Promise<PublicationStatus> {
  const row = await env.DB.prepare(
    "SELECT * FROM publication_sync WHERE id=1",
  ).first<SyncRow>();
  if (!row)
    throw new HttpError(
      503,
      "PUBLICATION_UNAVAILABLE",
      "Publication status is unavailable.",
    );
  const prefix =
    row.feed_id && row.latest_guid
      ? row.feed_id + ":" + (await sha256(row.latest_guid))
      : null;
  const assets: PublicationStatus["assets"] = {
    rss: emptyAsset(),
    transcript: emptyAsset(),
    chapters: emptyAsset(),
  };
  const results = await env.DB.prepare(
    "SELECT * FROM publication_assets WHERE asset_key IN (?,?,?)",
  )
    .bind(
      "rss",
      prefix ? prefix + ":transcript" : "",
      prefix ? prefix + ":chapters" : "",
    )
    .all<AssetRow>();
  for (const asset of results.results)
    assets[asset.kind] = {
      state: asset.state,
      checkedAt: asset.checked_at,
      fetchedAt: asset.fetched_at,
      hash: asset.hash,
      error: asset.error,
      nextRetryAt: asset.next_retry_at
        ? new Date(asset.next_retry_at).toISOString()
        : null,
      failureCount: asset.failure_count,
    };
  const latest =
    row.feed_id && row.latest_guid
      ? await env.DB.prepare(
          "SELECT data FROM publication_episodes WHERE feed_id=? AND guid=?",
        )
          .bind(row.feed_id, row.latest_guid)
          .first<{ data: string }>()
      : null;
  const running = !!row.lease_owner && (row.lease_expires_at ?? 0) > Date.now();
  return {
    configured: publicationConfigured(env),
    running,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastScheduledSuccessAt: row.last_scheduled_success_at,
    nextCheckAt: row.next_check_at
      ? new Date(row.next_check_at).toISOString()
      : null,
    lastError:
      row.last_error ??
      (row.lease_owner && !running
        ? "The previous publication check was interrupted; the next scheduled check will retry."
        : null),
    latest: latest ? (JSON.parse(latest.data) as PublishedEdition) : null,
    assets,
  };
}
export async function getPublishedEdition(
  db: D1Database,
  id: string,
): Promise<PublishedEdition | null> {
  const rows = await db
    .prepare(
      `SELECT p.data FROM publication_episodes p JOIN publication_assets a ON a.asset_key=p.transcript_asset_key WHERE p.episode_id=? AND a.state='ready' AND a.hash=json_extract(p.data,'$.transcriptHash') AND EXISTS(SELECT 1 FROM publication_assets WHERE asset_key='rss' AND state='ready') AND (SELECT count(*) FROM publication_episodes WHERE episode_id=p.episode_id)=1 LIMIT 2`,
    )
    .bind(id)
    .all<{ data: string }>();
  return rows.results.length === 1
    ? (JSON.parse(rows.results[0].data) as PublishedEdition)
    : null;
}
/** Call from the offset-hourly publication cron. Durable due gate prevents excess I/O. */
export async function syncPublication(
  env: PublicationEnv,
  options: { force?: boolean } = {},
): Promise<PublicationStatus> {
  if (!publicationConfigured(env) || env.LOCAL_DEMO === "true")
    return publicationStatus(env);
  const now = Date.now(),
    owner = crypto.randomUUID();
  const lease = await env.DB.prepare(
    `UPDATE publication_sync SET lease_owner=?,lease_expires_at=?,last_attempt_at=?,next_check_at=? WHERE id=1 AND (lease_owner IS NULL OR lease_expires_at<=?) AND (?=1 OR next_check_at<=?) RETURNING id`,
  )
    .bind(
      owner,
      now + LEASE,
      new Date(now).toISOString(),
      nextPublicationCheck(now),
      now,
      options.force ? 1 : 0,
      now,
    )
    .first<{ id: number }>();
  if (!lease) return publicationStatus(env);
  try {
    const deadline = now + DEADLINE;
    const feedId = await sha256(env.PUBLICATION_FEED_URL!);
    const rss = await asset(
      env,
      owner,
      "rss",
      "rss",
      env.PUBLICATION_FEED_URL!,
      deadline,
    );
    if (!rss.parsed) throw new Error("RSS unavailable");
    const latest = (JSON.parse(rss.parsed) as FeedEpisode[])[0];
    if (!latest) throw new Error("RSS has no episodes");
    const prefix = feedId + ":" + (await sha256(latest.guid));
    // Independent results: one blocked/malformed asset cannot prevent the other.
    const transcript = await asset(
      env,
      owner,
      prefix + ":transcript",
      "transcript",
      latest.transcriptUrl,
      deadline,
    );
    const chapters = await asset(
      env,
      owner,
      prefix + ":chapters",
      "chapters",
      latest.chaptersUrl,
      deadline,
    );
    await saveEpisode(env, owner, feedId, latest, transcript, chapters);
    const errors = [rss, transcript, chapters].filter(
      (a) => a.state === "blocked" || a.state === "error",
    );
    await env.DB.batch([
      fence(env.DB, owner),
      env.DB.prepare(
        "UPDATE publication_sync SET last_success_at=coalesce(?,last_success_at),last_scheduled_success_at=coalesce(?,last_scheduled_success_at),last_error=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=1 AND lease_owner=?",
      ).bind(
        rss.state === "ready" ? new Date().toISOString() : null,
        rss.state === "ready" && !options.force
          ? new Date().toISOString()
          : null,
        errors.length
          ? "Publication metadata updated; some assets need attention. See individual asset status."
          : null,
        owner,
      ),
    ]);
  } catch {
    await env.DB.prepare(
      "UPDATE publication_sync SET last_error=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=1 AND lease_owner=?",
    )
      .bind(
        "Publication check did not finish. Previously saved editions are preserved; the next hourly check will retry.",
        owner,
      )
      .run();
  }
  return publicationStatus(env);
}

/** Offline evidence input. Caller must establish actual episode media bytes separately. */
export async function getPublishedTranscript(
  db: D1Database,
  episodeId: string,
) {
  const edition = await getPublishedEdition(db, episodeId);
  if (!edition?.transcriptHash) return null;
  const asset = await db
    .prepare(
      "SELECT parsed FROM publication_asset_versions WHERE hash=? AND kind=?",
    )
    .bind(edition.transcriptHash, "transcript")
    .first<{ parsed: string }>();
  if (!asset) return null;
  const cues = JSON.parse(asset.parsed) as {
    id: string;
    startMs: number;
    endMs: number;
    text: string;
  }[];
  return {
    edition,
    coordinateSpace: "published_episode" as const,
    mediaFingerprint: null,
    transcriptFingerprint: edition.transcriptNormalizedHash,
    sourceOriginalSha256: edition.transcriptHash,
    cues: cues.map((cue) => ({ ...cue, kind: "speech" as const })),
  };
}
