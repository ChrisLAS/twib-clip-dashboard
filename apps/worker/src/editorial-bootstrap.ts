import type { EditorialProfile } from "@twib/shared";
import { editorialProfileSchema } from "./editorial";
import { fingerprint } from "./store";
import { HttpError } from "./errors";
/** Private operator tooling only; not an HTTP route or a credential grant. */
export async function prepareEditorialBootstrap(
  raw: unknown,
  verifiedOwnerPrincipal: string,
) {
  const input = editorialProfileSchema.parse(raw);
  if (!verifiedOwnerPrincipal.trim() || verifiedOwnerPrincipal.length > 256)
    throw new HttpError(
      422,
      "OWNER_REQUIRED",
      "Use the verified existing Access subject principal.",
    );
  if (
    input.action !== "replace" ||
    input.expectedRevision !== 0 ||
    input.scope !== "global" ||
    !input.rules?.length ||
    input.rules.some((r) => r.scope !== "global" || r.evidenceIds.length > 0) ||
    new Set(input.rules.map((r) => r.id)).size !== input.rules.length
  )
    throw new HttpError(
      422,
      "INVALID_BOOTSTRAP",
      "Bootstrap is limited to explicit global instructions on a fresh profile, without inferred evidence.",
    );
  const now = new Date().toISOString();
  const profile: EditorialProfile = {
    version: 1,
    enabled: true,
    rules: input.rules,
    feedback: [],
    proposals: [],
    updatedAt: now,
  };
  const fp = await fingerprint({ kind: "profile", input });
  const id =
    "bootstrap-" +
    (
      await fingerprint({
        owner: verifiedOwnerPrincipal,
        key: input.idempotencyKey,
      })
    ).slice(0, 48);
  return {
    actor: "assistant_bootstrap" as const,
    owner: verifiedOwnerPrincipal,
    requestFingerprint: fp,
    profile,
    // Same event trigger supplies revision fencing and immutable audit history.
    // Freshness is rechecked atomically; an unrecognized principal cannot create a profile.
    sql: "INSERT INTO editorial_events(id,owner,operation_key,fingerprint,expected_revision,action,reason,scope,data,created_at,actor) SELECT ?,?,?,?,0,'replace',?,'global',?,?,'assistant_bootstrap' WHERE coalesce((SELECT version FROM editorial_profiles WHERE owner=?),0)=0 AND NOT EXISTS(SELECT 1 FROM editorial_events WHERE owner=?) AND EXISTS(SELECT 1 FROM review_events WHERE reviewer=?)",
    params: [
      id,
      verifiedOwnerPrincipal,
      input.idempotencyKey,
      fp,
      input.reason,
      JSON.stringify(profile),
      now,
      verifiedOwnerPrincipal,
      verifiedOwnerPrincipal,
      verifiedOwnerPrincipal,
    ],
    reconcileSql:
      "SELECT fingerprint,data,actor FROM editorial_events WHERE owner=? AND operation_key=?",
    reconcileParams: [verifiedOwnerPrincipal, input.idempotencyKey],
  };
}
