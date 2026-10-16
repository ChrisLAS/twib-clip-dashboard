import {
  cutWireSchema,
  planWireSchema,
  derivativeSchema,
  proposalSchema,
} from "./cut-contract";
import { z } from "zod";
const uuid = z
  .string()
  .uuid()
  .regex(/^[0-9a-f-]+$/);
export const publicCaptureUrl = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    const forbidden =
      /\s|\\/.test(value) ||
      [...value].some(
        (char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127,
      );
    const youtube =
      /^https:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?v=[A-Za-z0-9_-]{11}|(?:shorts|live)\/[A-Za-z0-9_-]{11})$/.test(
        value,
      );
    const short = /^https:\/\/youtu\.be\/[A-Za-z0-9_-]{11}$/.test(value);
    const vimeo = /^https:\/\/(?:www\.)?vimeo\.com\/[0-9]{1,20}$/.test(value);
    const social =
      /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]{1,15}\/status\/[0-9]{1,30}$/.test(
        value,
      );
    if (forbidden || !(youtube || short || vimeo || social))
      ctx.addIssue({ code: "custom", message: "Public capture URL required" });
  });
export const createJobSchema = z
  .object({
    job_id: uuid,
    intake_work_id: uuid.optional(),
    show: z.literal("twib"),
    episode: z.number().int().min(1).max(999999),
    url: publicCaptureUrl,
    reported_by: z.enum(["chad", "number-one"]),
  })
  .strict();
export const claimSchema = z
  .object({
    request_id: uuid,
    job_kind: z.enum(["capture", "cut", "plan"]).optional(),
  })
  .strict();
export const retrySchema = z.object({ retry_id: uuid }).strict();
export const captureReceiptSchema = z
  .object({
    version: z.literal(1),
    job_id: uuid,
    ref: z.string().regex(/^new-review\/[A-Za-z0-9][A-Za-z0-9._-]{0,240}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.number().int().min(1).max(536870912),
    duration_seconds: z.number().finite().positive().max(86400),
    show: z.literal("twib"),
    episode: z.number().int().min(1).max(999999),
    editorial_ready: z.literal(false),
  })
  .strict();
export const resultSchema = z
  .object({
    delivery_id: uuid,
    job_id: uuid,
    lease_id: uuid,
    state: z.enum([
      "waiting_for_episode",
      "blocked",
      "running",
      "needs_review",
      "succeeded",
    ]),
    attempt: z.number().int().min(0).max(100),
    result: derivativeSchema.optional(),
    capture: captureReceiptSchema.optional(),
    proposal: proposalSchema.optional(),
    code: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,80}$/)
      .nullable(),
  })
  .strict();
export type CaptureClaim = {
  kind?: undefined;
  job_id: string;
  intake_work_id?: string;
  show: "twib";
  episode: number;
  url: string;
  reported_by: "chad" | "number-one";
  operation: "capture" | "retry";
  retry_id: string | null;
  lease_id: string;
  lease_expires_at: string;
  executor: "nomad:capture-worker";
};
export type Claim =
  | CaptureClaim
  | (z.infer<typeof cutWireSchema | typeof planWireSchema> & {
      url?: never;
    } & Pick<
        CaptureClaim,
        "operation" | "retry_id" | "lease_id" | "lease_expires_at" | "executor"
      >);
export type ClaimResponse = { version: 1; claim: Claim | null };
