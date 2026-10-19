import { advanceIntakeWork, intakeWorkEnabled } from "./intake-work";
import { planningEnabled } from "./cut";
import { transitionAfterReceipt } from "./plan";
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
export const PLAN_RESULT_MAX_BYTES = 32768;
export async function jobBody(
  request: Request,
  maxBytes = 4096,
): Promise<unknown> {
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
        if (size > maxBytes) {
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
  const isClaim = new URL(request.url).pathname.endsWith("/claim");
  const input = await jobBody(
    request,
    !isClaim && planningEnabled(env) ? PLAN_RESULT_MAX_BYTES : 4096,
  );
  if (isClaim) {
    const claim = claimSchema.parse(input);
    requireKind(env, claim.job_kind ?? "capture");
    return json(
      await claimJob(env.DB, claim, Date.now(), {
        episode: Number(env.CAPTURE_JOBS_GRANT_EPISODE),
        intakeEnabled: intakeWorkEnabled(env),
        issuedAfter: Date.parse(env.CAPTURE_JOBS_GRANT_STARTS_AT!),
      }),
    );
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
  if (
    JSON.parse(job.request_json).episode !==
    Number(env.CAPTURE_JOBS_GRANT_EPISODE)
  )
    throw new HttpError(
      403,
      "JOB_EPISODE_SCOPE_DENIED",
      "Job episode is outside the exact grant.",
    );
  if (
    result.state === "running" &&
    JSON.parse(job.request_json).intake_work_id &&
    !intakeWorkEnabled(env)
  )
    throw new HttpError(
      403,
      "INTAKE_WORK_DISABLED",
      "Intake processing is disabled; do not start work.",
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
  if (result.capture) await advanceIntakeWork(env, result.job_id);
  if (
    JSON.parse(job.request_json).kind === "plan" &&
    result.code === "EDITORIAL_PROPOSAL_READY"
  )
    await transitionAfterReceipt(env, result.job_id);
  return json(ack);
}
