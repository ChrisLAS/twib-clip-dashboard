export interface Draft {
  note: string;
  reason: string;
}
const key = (renderId: string) => `twib-review-draft:${renderId}`;
/** Tab-scoped only. Storage failures never prevent reviewing or typing. */
export function readDraft(renderId: string): Draft | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(renderId)) || "null");
    if (
      value &&
      typeof value.note === "string" &&
      value.note.length <= 4000 &&
      typeof value.reason === "string" &&
      value.reason.length <= 100
    )
      return value;
  } catch {
    /* Privacy mode or invalid draft */
  }
  return undefined;
}
export function storeDraft(renderId: string, draft: Draft | undefined) {
  try {
    if (draft) sessionStorage.setItem(key(renderId), JSON.stringify(draft));
    else sessionStorage.removeItem(key(renderId));
  } catch {
    /* In-memory draft remains available */
  }
}
