import { z } from "zod";
export const cutSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("range"),
      startSeconds: z.number().finite().min(0).max(86400),
      endSeconds: z.number().finite().positive().max(86400),
    })
    .strict()
    .refine(
      (v) =>
        v.endSeconds > v.startSeconds &&
        v.endSeconds - v.startSeconds <= 180 &&
        [v.startSeconds, v.endSeconds].every(
          (n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-7,
        ),
      "Use a complete positive range of at most 180 seconds with millisecond precision.",
    ),
  z
    .object({
      kind: z.literal("editorial"),
      guidance: z.string().trim().min(1).max(2000),
      startSeconds: z.number().finite().min(0).max(86400).optional(),
    })
    .strict(),
]);
export const cutParentSchema = z
  .object({
    item_id: z.string().regex(/^item_[a-f0-9]{64}$/),
    clip_id: z.string().max(128).nullable(),
    clip_uid: z.string().max(128).nullable(),
    ref: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (v) =>
          !v.startsWith("/") &&
          !v.includes("\\") &&
          !v.split("/").some((p) => !p || p === "." || p === "..") &&
          !Array.from(v).some(
            (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
          ),
      ),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    size_bytes: z.number().int().positive(),
    modified_at: z.string().nullable(),
  })
  .strict();
export const cutWireSchema = z
  .object({
    job_id: z
      .string()
      .uuid()
      .regex(/^[0-9a-f-]+$/),
    kind: z.literal("cut"),
    show: z.literal("twib"),
    episode: z.literal(127),
    reported_by: z.literal("chad"),
    parent: cutParentSchema,
    spec: cutSpecSchema,
  })
  .strict();
export const derivativeSchema = z
  .object({
    clip_id: z.string().regex(/^[0-9a-f-]{36}-a[1-9][0-9]*$/),
    parent_clip_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    source_long_clip_id: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
      .nullable(),
    ref: z.string().regex(/^new-review\/[0-9a-f-]{36}-a[1-9][0-9]*\.mp4$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.number().int().positive().max(536870912),
    duration_seconds: z.number().finite().positive().max(181),
    local_in_seconds: z.number().finite().min(0),
    local_out_seconds: z.number().finite().positive(),
    ready: z.literal(false),
    approval: z.literal("unreviewed"),
  })
  .strict();
