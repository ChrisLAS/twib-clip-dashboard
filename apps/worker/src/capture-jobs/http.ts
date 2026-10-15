import { transitionFirstPass } from "./plan";
import { requireKind } from "./scope";
import { claimSchema, resultSchema } from "./contract";
import type { Env } from "../env";
import { HttpError, json } from "../errors";
import { authenticateCaptureJobs } from "./auth";
import { claimJob, acceptResult } from "./store";
export function requireJobsEnabled(env: Env) {
  if (env.CAPTURE_JOBS_ENABLED !== "true")
    throw new HttpError(
      503,
      "CAPTURE_JOBS_DISABLED",
      "Capture jobs are not activated.",
    );
}
export async function jobBody(request: Request): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new HttpError(415, "JSON_REQUIRED", "Use JSON requests.");
  const reader = request.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4096) {
          await reader.cancel();
          throw new HttpError(
            413,
            "REQUEST_TOO_LARGE",
            "Request is too large.",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON request.");
  }
}
export async function machineJobs(request: Request, env: Env) {
  requireJobsEnabled(env);
  await authenticateCaptureJobs(request, env);
  const input = await jobBody(request);
  if (new URL(request.url).pathname.endsWith("/claim")) {
    const claim = claimSchema.parse(input);
    requireKind(env, claim.job_kind ?? "capture");
    return json(await claimJob(env.DB, claim));
  }
  const result = resultSchema.parse(input);
  // Resolve immutable server-side identity before any receipt replay or mutation.
  const job = await env.DB.prepare(
    "SELECT request_json FROM capture_jobs WHERE job_id=?",
  )
    .bind(result.job_id)
    .first<{ request_json: string }>();
  if (!job)
    throw new HttpError(
      409,
      "JOB_CONFLICT",
      "Reconcile the existing job before retrying.",
    );
  requireKind(
    env,
    JSON.parse(job.request_json).kind === "plan"
      ? "plan"
      : JSON.parse(job.request_json).kind === "cut"
        ? "cut"
        : "capture",
  );
  const ack = await acceptResult(env.DB, result);
  if (
    JSON.parse(job.request_json).kind === "plan" &&
    result.code === "EDITORIAL_PROPOSAL_READY"
  )
    await transitionFirstPass(env, result.job_id);
  return json(ack);
}
