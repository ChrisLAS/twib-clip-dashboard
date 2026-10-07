import { z } from "zod";
import type { Env } from "./env";
import { HttpError } from "./errors";
import { googleToken, upstreamError } from "./google";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
const time = z.iso.datetime({ offset: true });
const ms = z.number().int().nonnegative();
const event = z
  .object({
    schemaVersion: z.literal(1),
    id,
    attemptId: id,
    clipId: id,
    sequence: ms,
    occurredAt: time,
    stage: z.string().max(300),
    state: z.enum([
      "queued",
      "working",
      "ready",
      "blocked",
      "failed",
      "cancelled",
      "unknown",
    ]),
    progress: z.boolean(),
    nextExpectedAt: time.nullable(),
    blocker: z.string().max(2000).nullable(),
    checkpoint: z.string().max(2000).nullable(),
  })
  .strict();
const source = z
  .object({
    title: z.string().max(500),
    speaker: z.string().max(200),
    url: z
      .url()
      .refine((s) => s.startsWith("https://"))
      .nullable(),
    edition: z.string().max(200),
    recordingDate: time.nullable(),
    publicationDate: time.nullable(),
    retrievedAt: time.nullable(),
    inMs: ms,
    outMs: ms,
    context: z.string().max(5000),
  })
  .strict();
const render = z
  .object({
    id,
    clipId: id,
    version: z.number().int().positive(),
    title: z.string().max(500),
    durationMs: z.number().int().positive(),
    createdAt: time,
    recipeHash: z.string().min(1).max(128),
    artifactHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    source,
    mappingVerified: z.boolean(),
    cues: z
      .array(
        z
          .object({ id, text: z.string().max(10000), startMs: ms, endMs: ms })
          .strict(),
      )
      .max(5000),
    qa: z
      .array(
        z
          .object({
            check: z.string().max(200),
            result: z.enum(["passed", "failed", "unknown"]),
            method: z.string().max(1000),
            checkedAt: time.nullable(),
            artifactHash: z.string().nullable(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.source.outMs <= r.source.inMs)
      ctx.addIssue({ code: "custom", message: "Invalid source range" });
    for (const cue of r.cues)
      if (cue.endMs <= cue.startMs || cue.endMs > r.durationMs)
        ctx.addIssue({ code: "custom", message: "Invalid render cue range" });
  });
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    episodes: z
      .array(
        z
          .object({
            id,
            number: z.number().int(),
            title: z.string().max(500),
            subtitle: z.string().max(500),
            clipCount: ms,
            publishedGuid: z.string().max(1000).nullable(),
          })
          .strict(),
      )
      .max(20),
    clips: z
      .array(
        z
          .object({
            id,
            episodeId: id,
            title: z.string().max(500),
            summary: z.string().max(5000),
            narrativeRole: z.string().max(100),
            currentRenderId: id,
            renderIds: z.array(id).max(100),
          })
          .strict(),
      )
      .max(200),
    renders: z.array(render).max(500),
    artifacts: z
      .array(
        z
          .object({
            renderId: id,
            kind: z.enum(["original", "proxy"]),
            fileId: id,
            size: z.number().int().positive(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(1000),
    events: z.array(event).max(2000),
    activations: z
      .array(
        z
          .object({ clipId: id, attemptId: id, supersedes: id.nullable() })
          .strict(),
      )
      .max(200),
  })
  .strict();
// The only remote source is this server-configured private Sheet. Each A cell is one complete immutable JSON manifest.
export async function pullManifest(env: Env): Promise<{ imported: number }> {
  if (
    !env.PRODUCER_SHEET_ID ||
    !env.PRODUCER_SHEET_RANGE ||
    !env.ALLOWED_EPISODE_IDS ||
    !env.ALLOWED_DRIVE_FOLDER_IDS
  )
    throw new HttpError(
      503,
      "PRODUCER_UNCONFIGURED",
      "The approved private producer Sheet and folder allowlists are not configured.",
    );
  const token = await googleToken(env);
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.PRODUCER_SHEET_ID)}/values/${encodeURIComponent(env.PRODUCER_SHEET_RANGE)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw upstreamError(r.status);
  const raw = await r.text();
  if (raw.length > 2_000_000)
    throw new HttpError(
      413,
      "IMPORT_TOO_LARGE",
      "Producer data exceeds the import limit.",
    );
  const data = JSON.parse(raw) as { values?: unknown[][] };
  let imported = 0;
  for (const row of data.values ?? []) {
    if (typeof row[0] !== "string") continue;
    const parsed = manifestSchema.safeParse(JSON.parse(row[0]));
    if (!parsed.success)
      throw new HttpError(
        422,
        "INVALID_MANIFEST",
        "Producer manifest is invalid. Correct the source record without rewriting imported events.",
      );
    await importManifest(env, parsed.data, token);
    imported++;
  }
  await env.DB.prepare(
    "UPDATE sync_state SET last_success_at=?,last_error=NULL WHERE id=1",
  )
    .bind(new Date().toISOString())
    .run();
  return { imported };
}
export async function importManifest(
  env: Env,
  m: z.infer<typeof manifestSchema>,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(m)),
  );
  const manifestHash = Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
  if (
    await env.DB.prepare("SELECT hash FROM imported_manifests WHERE hash=?")
      .bind(manifestHash)
      .first()
  )
    return;
  const duplicate = (values: string[]) =>
    new Set(values).size !== values.length;
  if (
    [m.episodes, m.clips, m.renders, m.events].some((rows) =>
      duplicate(rows.map((r) => r.id)),
    ) ||
    duplicate(m.events.map((e) => `${e.attemptId}:${e.sequence}`)) ||
    duplicate(m.artifacts.map((a) => `${a.renderId}:${a.kind}`)) ||
    duplicate(m.activations.map((a) => a.clipId))
  )
    throw new HttpError(
      422,
      "DUPLICATE_MANIFEST_KEY",
      "A manifest contains duplicate record keys.",
    );
  const clipEpisode = async (id: string) =>
    m.clips.find((c) => c.id === id)?.episodeId ??
    (
      await env.DB.prepare("SELECT episode_id FROM clips WHERE id=?")
        .bind(id)
        .first<{ episode_id: string }>()
    )?.episode_id;
  const renderClip = async (id: string) =>
    m.renders.find((r) => r.id === id)?.clipId ??
    (
      await env.DB.prepare("SELECT clip_id FROM renders WHERE id=?")
        .bind(id)
        .first<{ clip_id: string }>()
    )?.clip_id;
  for (const c of m.clips) {
    if (!c.renderIds.includes(c.currentRenderId))
      throw new HttpError(
        422,
        "INVALID_RENDER_REFERENCE",
        "Current render must be in clip history.",
      );
    for (const id of c.renderIds)
      if ((await renderClip(id)) !== c.id)
        throw new HttpError(
          422,
          "INVALID_RENDER_REFERENCE",
          "Clip render history references another clip or a missing render.",
        );
  }
  for (const r of m.renders) {
    const episode = await clipEpisode(r.clipId);
    if (
      !episode ||
      !(env.ALLOWED_EPISODE_IDS ?? "").split(",").includes(episode)
    )
      throw new HttpError(
        422,
        "INVALID_CLIP_REFERENCE",
        "Render references a missing or unapproved clip.",
      );
  }
  for (const a of m.artifacts) {
    const clip = await renderClip(a.renderId);
    const episode = clip ? await clipEpisode(clip) : undefined;
    if (
      !episode ||
      !(env.ALLOWED_EPISODE_IDS ?? "").split(",").includes(episode)
    )
      throw new HttpError(
        422,
        "INVALID_ARTIFACT_REFERENCE",
        "Artifact references a missing or unapproved render.",
      );
  }
  const attemptOwners = new Map<string, string>();
  for (const e of m.events) {
    const episode = await clipEpisode(e.clipId);
    if (
      !episode ||
      !(env.ALLOWED_EPISODE_IDS ?? "").split(",").includes(episode)
    )
      throw new HttpError(
        422,
        "INVALID_EVENT_REFERENCE",
        "Event references a missing or unapproved clip.",
      );
    const existing = await env.DB.prepare(
      "SELECT clip_id FROM producer_events WHERE attempt_id=? LIMIT 1",
    )
      .bind(e.attemptId)
      .first<{ clip_id: string }>();
    const owner = attemptOwners.get(e.attemptId) ?? existing?.clip_id;
    if (owner && owner !== e.clipId)
      throw new HttpError(
        422,
        "ATTEMPT_OWNERSHIP",
        "An attempt cannot belong to multiple clips.",
      );
    attemptOwners.set(e.attemptId, e.clipId);
  }
  for (const a of m.activations) {
    const owner =
      attemptOwners.get(a.attemptId) ??
      (
        await env.DB.prepare(
          "SELECT clip_id FROM producer_events WHERE attempt_id=? LIMIT 1",
        )
          .bind(a.attemptId)
          .first<{ clip_id: string }>()
      )?.clip_id;
    if (owner !== a.clipId)
      throw new HttpError(
        422,
        "ATTEMPT_OWNERSHIP",
        "Activation references an invalid attempt.",
      );
  }
  const allowed = (env.ALLOWED_EPISODE_IDS ?? "").split(",");
  if (
    m.episodes.some((e) => !allowed.includes(e.id)) ||
    m.clips.some((c) => !allowed.includes(c.episodeId))
  )
    throw new HttpError(
      403,
      "EPISODE_NOT_ALLOWED",
      "Manifest references an episode outside the allowlist.",
    );
  for (const a of m.artifacts) {
    if (a.kind === "original") {
      const render =
        m.renders.find((r) => r.id === a.renderId) ??
        (JSON.parse(
          (
            await env.DB.prepare("SELECT data FROM renders WHERE id=?")
              .bind(a.renderId)
              .first<{ data: string }>()
          )?.data ?? "null",
        ) as { artifactHash: string | null } | null);
      if (!render?.artifactHash || render.artifactHash !== a.sha256)
        throw new HttpError(
          422,
          "ARTIFACT_HASH_MISMATCH",
          "Original artifact must match the exact render hash.",
        );
    }
    const response = await fetcher(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(a.fileId)}?fields=parents,size,mimeType,sha256Checksum,capabilities(canDownload)`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw upstreamError(response.status);
    const f = (await response.json()) as {
      parents?: string[];
      size: string;
      mimeType: string;
      sha256Checksum: string;
      capabilities?: { canDownload?: boolean };
    };
    if (
      !f.parents?.some((p) =>
        (env.ALLOWED_DRIVE_FOLDER_IDS ?? "").split(",").includes(p),
      ) ||
      Number(f.size) !== a.size ||
      f.mimeType !== "video/mp4" ||
      f.sha256Checksum !== a.sha256 ||
      !f.capabilities?.canDownload
    )
      throw new HttpError(
        422,
        "ARTIFACT_UNVERIFIED",
        "Artifact folder, checksum, size, or download capability failed verification.",
      );
  }
  const statements: D1PreparedStatement[] = [];
  async function immutable(
    table: string,
    key: string,
    value: string,
    extra: unknown[],
    sql: string,
  ) {
    const old = await env.DB.prepare(`SELECT data FROM ${table} WHERE id=?`)
      .bind(key)
      .first<{ data: string }>();
    if (old && old.data !== value)
      throw new HttpError(
        409,
        "IMMUTABLE_CONFLICT",
        "An imported ID has changed. Issue a new render or correction event.",
      );
    if (!old) statements.push(env.DB.prepare(sql).bind(key, ...extra, value));
  }
  for (const e of m.episodes)
    await immutable(
      "episodes",
      e.id,
      JSON.stringify(e),
      [],
      "INSERT OR IGNORE INTO episodes VALUES(?,?)",
    );
  for (const c of m.clips) {
    const old = await env.DB.prepare(
      "SELECT data,episode_id FROM clips WHERE id=?",
    )
      .bind(c.id)
      .first<{ data: string; episode_id: string }>();
    if (old) {
      const previous = JSON.parse(old.data) as {
        renderIds: string[];
        currentRenderId: string;
      };
      if (old.episode_id !== c.episodeId)
        throw new HttpError(
          409,
          "IMMUTABLE_CONFLICT",
          "Clip cannot move episodes.",
        );
      if (!previous.renderIds.every((id) => c.renderIds.includes(id)))
        throw new HttpError(
          409,
          "RENDER_HISTORY_REMOVED",
          "Manifest cannot remove render history.",
        );
      if (previous.currentRenderId !== c.currentRenderId) {
        const next = m.renders.find(
          (r) => r.id === c.currentRenderId && r.clipId === c.id,
        );
        const oldRender = await env.DB.prepare(
          "SELECT data FROM renders WHERE id=?",
        )
          .bind(previous.currentRenderId)
          .first<{ data: string }>();
        if (
          !next ||
          !oldRender ||
          next.version <=
            (JSON.parse(oldRender.data) as { version: number }).version
        )
          throw new HttpError(
            409,
            "OLD_RENDER",
            "Current render cannot regress.",
          );
      }
      statements.push(
        env.DB.prepare(
          "UPDATE clips SET data=json_set(data,'$.currentRenderId',?,'$.renderIds',json(?)) WHERE id=? AND data=?",
        ).bind(c.currentRenderId, JSON.stringify(c.renderIds), c.id, old.data),
      );
    } else
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO clips(id,episode_id,data) VALUES(?,?,?)",
        ).bind(
          c.id,
          c.episodeId,
          JSON.stringify({
            ...c,
            airing: {
              state: "unknown",
              evidence: null,
              verifiedAt: null,
              renderId: null,
            },
          }),
        ),
      );
  }
  for (const r of m.renders)
    await immutable(
      "renders",
      r.id,
      JSON.stringify(r),
      [r.clipId],
      "INSERT OR IGNORE INTO renders(id,clip_id,data) VALUES(?,?,?)",
    );
  for (const a of m.artifacts) {
    const old = await env.DB.prepare(
      "SELECT file_id,size,sha256 FROM artifacts WHERE render_id=? AND kind=?",
    )
      .bind(a.renderId, a.kind)
      .first<{ file_id: string; size: number; sha256: string }>();
    if (
      old &&
      (old.file_id !== a.fileId ||
        old.size !== a.size ||
        old.sha256 !== a.sha256)
    )
      throw new HttpError(
        409,
        "IMMUTABLE_CONFLICT",
        "Artifact identity changed. Create a new render.",
      );
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?,?)",
      ).bind(a.renderId, a.kind, a.fileId, a.size, a.sha256, "video/mp4"),
    );
  }
  for (const e of m.events) {
    if (Date.parse(e.occurredAt) > Date.now() + 300000)
      throw new HttpError(
        422,
        "FUTURE_EVENT",
        "Producer event time is in the future.",
      );
    const old = await env.DB.prepare(
      "SELECT data FROM producer_events WHERE id=? OR (attempt_id=? AND sequence=?)",
    )
      .bind(e.id, e.attemptId, e.sequence)
      .first<{ data: string }>();
    if (old && old.data !== JSON.stringify(e))
      throw new HttpError(
        409,
        "IMMUTABLE_CONFLICT",
        "Producer event or sequence changed.",
      );
    if (!old)
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO producer_events VALUES(?,?,?,?,?)",
        ).bind(e.id, e.attemptId, e.clipId, e.sequence, JSON.stringify(e)),
      );
  }
  for (const a of m.activations)
    statements.push(
      env.DB.prepare(
        "UPDATE clips SET active_attempt_id=? WHERE id=? AND active_attempt_id IS ? AND EXISTS(SELECT 1 FROM producer_events WHERE attempt_id=? AND clip_id=?)",
      ).bind(a.attemptId, a.clipId, a.supersedes, a.attemptId, a.clipId),
    );
  statements.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO imported_manifests(hash,imported_at) VALUES(?,?)",
    ).bind(manifestHash, new Date().toISOString()),
  );
  await env.DB.batch(statements);
}
