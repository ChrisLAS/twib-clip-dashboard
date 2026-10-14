import type { Env } from "../env";
import { HttpError } from "../errors";
export type JobKind = "capture" | "cut";
// Missing/unknown operation grants are closed. Identity/action scopes do not
// implicitly authorize either job kind.
export function kindGranted(env: Env, kind: JobKind): boolean {
  const grant = env.CAPTURE_JOBS_GRANT_OPERATIONS;
  return grant === kind || grant === "capture,cut";
}
export function requireKind(env: Env, kind: JobKind): void {
  if (!kindGranted(env, kind))
    throw new HttpError(
      403,
      "JOB_KIND_SCOPE_DENIED",
      "This job kind is not authorized.",
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
