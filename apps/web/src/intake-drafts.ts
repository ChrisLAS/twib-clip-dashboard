import type { IntakeCreateInput, IntakeUpdateInput } from "@twib/shared";

export type Fields = {
  url: string;
  episodeId: string;
  kind: "already_cut" | "full_source";
  start: string;
  end: string;
  why: string;
};
export type Attempt = {
  id: string | null;
  body: IntakeCreateInput | IntakeUpdateInput;
};
export type SavedDraft = {
  fields: Fields;
  editing: string | null;
  baselineRevision: number | null;
  attempt: Attempt | null;
};
const draftKey = "twib:manual-intake:v1";
export function readIntakeDraft(editing?: string | null): SavedDraft | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(
        editing === undefined ? draftKey : `${draftKey}:${editing ?? "new"}`,
      ) ?? "null",
    );
    if (!value || typeof value !== "object" || !("fields" in value))
      return null;
    const candidate = value as SavedDraft;
    if (
      typeof candidate.fields.url !== "string" ||
      typeof candidate.fields.episodeId !== "string" ||
      !["already_cut", "full_source"].includes(candidate.fields.kind) ||
      typeof candidate.fields.start !== "string" ||
      typeof candidate.fields.end !== "string" ||
      typeof candidate.fields.why !== "string"
    )
      return null;
    if (candidate.editing && !Number.isInteger(candidate.baselineRevision))
      return null;
    if (
      candidate.attempt &&
      (!candidate.attempt.body ||
        typeof candidate.attempt.body.idempotencyKey !== "string")
    )
      return null;
    return candidate;
  } catch {
    return null;
  }
}
export function saveIntakeDraft(draft: SavedDraft | null) {
  try {
    if (draft) {
      sessionStorage.setItem(draftKey, JSON.stringify(draft));
      sessionStorage.setItem(
        `${draftKey}:${draft.editing ?? "new"}`,
        JSON.stringify(draft),
      );
    } else {
      const current = readIntakeDraft();
      if (current)
        sessionStorage.removeItem(`${draftKey}:${current.editing ?? "new"}`);
      sessionStorage.removeItem(draftKey);
    }
  } catch {
    /* The current tab still retains the request. */
  }
}
