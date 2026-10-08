import { z } from "zod";
import type { Render } from "@twib/shared";
import type {
  RenderTranscriptInput,
  RenderTranscriptAsset,
} from "../../../packages/shared/src/render-transcripts";
import { fingerprint, getRender, operation } from "./store";
import { HttpError } from "./errors";
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const renderTranscriptInputSchema = z
  .object({
    idempotencyKey: id.min(8),
    renderId: id,
    mediaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.literal("machine_asr"),
    alignment: z.literal("exact_render"),
    textAccuracy: z.literal("unverified"),
    sourceMapping: z.literal("unknown"),
    cues: z
      .array(
        z
          .object({
            id,
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
            text: z.string().trim().min(1).max(5000),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set<string>();
    v.cues.forEach((cue, i) => {
      if (
        ids.has(cue.id) ||
        cue.endMs <= cue.startMs ||
        (i > 0 && cue.startMs < v.cues[i - 1].endMs)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Cues must have unique IDs and ordered, nonoverlapping positive ranges.",
        });
      ids.add(cue.id);
    });
    if (v.cues.reduce((n, c) => n + c.text.length, 0) > 500000)
      ctx.addIssue({
        code: "custom",
        message: "Transcript text exceeds safety bound.",
      });
  });
/** Shared by the owner API and authorized private bootstrap. Does not fetch media. */
export async function prepareRenderTranscriptAsset(
  input: RenderTranscriptInput,
  render: Render,
  owner: string,
): Promise<RenderTranscriptAsset> {
  input = renderTranscriptInputSchema.parse(input);
  if (
    input.renderId !== render.id ||
    !render.artifactHash ||
    input.mediaSha256 !== render.artifactHash
  )
    throw new HttpError(
      409,
      "RENDER_HASH_MISMATCH",
      "Transcript must identify the exact stored render bytes.",
    );
  if (
    !Number.isSafeInteger(render.durationMs) ||
    render.durationMs <= 0 ||
    input.cues.some((c) => c.endMs > render.durationMs)
  )
    throw new HttpError(
      422,
      "OUT_OF_RANGE",
      "Transcript cues exceed the exact render duration.",
    );
  const cues = input.cues.map((c) => ({
    id: c.id,
    startMs: c.startMs,
    endMs: c.endMs,
    text: c.text,
  }));
  const transcriptHash = await fingerprint({
    version: "render-transcript-v1",
    coordinateSpace: "clip_render",
    cues,
  });
  const content = {
    renderId: render.id,
    mediaSha256: input.mediaSha256,
    durationMs: render.durationMs,
    origin: input.origin,
    alignment: input.alignment,
    textAccuracy: input.textAccuracy,
    sourceMapping: input.sourceMapping,
    coordinateSpace: "clip_render" as const,
    cues,
    transcriptHash,
  };
  const assetHash = await fingerprint(content);
  return {
    ...content,
    id: "rta-" + (await fingerprint({ owner, assetHash })).slice(0, 48),
    assetHash,
    createdAt: new Date().toISOString(),
  };
}
export async function getRenderTranscriptAsset(
  db: D1Database,
  id: string,
  owner: string,
): Promise<RenderTranscriptAsset | null> {
  const row = await db
    .prepare("SELECT data FROM render_transcript_assets WHERE id=? AND owner=?")
    .bind(id, owner)
    .first<{ data: string }>();
  return row ? JSON.parse(row.data) : null;
}
export async function selectRenderTranscriptAsset(
  db: D1Database,
  render: Render,
  owner: string,
): Promise<RenderTranscriptAsset | null> {
  const row = await db
    .prepare(
      "SELECT data FROM render_transcript_assets WHERE owner=? AND render_id=? AND media_sha256=? AND duration_ms=? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(owner, render.id, render.artifactHash, render.durationMs)
    .first<{ data: string }>();
  return row ? JSON.parse(row.data) : null;
}
export async function importRenderTranscriptAsset(
  db: D1Database,
  input: RenderTranscriptInput,
  owner: string,
): Promise<RenderTranscriptAsset> {
  input = renderTranscriptInputSchema.parse(input);
  const fp = await fingerprint({
    kind: "render_transcript_import",
    input,
    owner,
  });
  async function prior() {
    const receipt = await operation(db, input.idempotencyKey, owner);
    if (receipt) {
      if (receipt.fingerprint !== fp)
        throw new HttpError(
          409,
          "IDEMPOTENCY_REUSE",
          "Request key belongs to different content.",
        );
      return JSON.parse(receipt.response) as RenderTranscriptAsset;
    }
    if (await operation(db, input.idempotencyKey))
      throw new HttpError(
        409,
        "IDEMPOTENCY_REUSE",
        "Request key is unavailable.",
      );
    return null;
  }
  const previous = await prior();
  if (previous) return previous;
  const asset = await prepareRenderTranscriptAsset(
    input,
    await getRender(db, input.renderId),
    owner,
  );
  try {
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO render_transcript_assets(id,owner,render_id,media_sha256,duration_ms,transcript_hash,asset_hash,created_at,data) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          asset.id,
          owner,
          asset.renderId,
          asset.mediaSha256,
          asset.durationMs,
          asset.transcriptHash,
          asset.assetHash,
          asset.createdAt,
          JSON.stringify(asset),
        ),
      db
        .prepare(
          "INSERT INTO operations(id,fingerprint,response) SELECT ?,?,data FROM render_transcript_assets WHERE id=? AND owner=?",
        )
        .bind(input.idempotencyKey, fp, asset.id, owner),
      db
        .prepare("INSERT INTO operation_owners VALUES(?,?)")
        .bind(input.idempotencyKey, owner),
    ]);
  } catch {
    const raced = await prior();
    if (raced) return raced;
    throw new HttpError(
      503,
      "SAVE_UNCONFIRMED",
      "Transcript import could not be confirmed. Reuse the same request key.",
    );
  }
  const saved = await prior();
  if (!saved)
    throw new HttpError(
      503,
      "SAVE_UNCONFIRMED",
      "Transcript import could not be confirmed.",
    );
  return saved;
}
