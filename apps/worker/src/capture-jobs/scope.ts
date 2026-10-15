import type { Env } from "../env";
import { HttpError } from "../errors";
export type JobKind = "capture" | "cut" | "plan";
// Missing/unknown operation grants are closed. Identity/action scopes do not
// implicitly authorize either job kind.
export function kindGranted(env: Env, kind: JobKind): boolean {
  const grant = env.CAPTURE_JOBS_GRANT_OPERATIONS;
  return (
    typeof grant === "string" &&
    [
      "capture",
      "cut",
      "plan",
      "capture,cut",
      "capture,plan",
      "cut,plan",
      "capture,cut,plan",
    ].includes(grant) &&
    grant.split(",").includes(kind)
  );
}
export function requireKind(env: Env, kind: JobKind): void {
  if (!kindGranted(env, kind))
    throw new HttpError(
      403,
      "JOB_KIND_SCOPE_DENIED",
      "This job kind is not authorized.",
    );
  if (
    kind === "plan" &&
    (env.CUT_REQUESTS_ENABLED !== "true" || env.CUT_PLANNING_ENABLED !== "true")
  )
    throw new HttpError(
      503,
      "CUT_PLANNING_DISABLED",
      "Editorial planning is not activated.",
    );
  if (
    kind === "cut" &&
    (env.CUT_REQUESTS_ENABLED !== "true" || env.CUT_JOBS_ENABLED !== "true")
  )
    throw new HttpError(
      503,
      "CUT_JOBS_DISABLED",
      "Cut execution is not activated.",
    );
}
