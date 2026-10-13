import type { InventoryResponse } from "@twib/shared";
export type InventoryRecordItem = InventoryResponse["items"][number];
export type LocalFile = Pick<
  File,
  "name" | "size" | "lastModified" | "webkitRelativePath"
>;
export const AUDIO_SUFFIX = /\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i;
const AV_SUFFIX = /\.(mp4|webm|mkv|mov|m4v|mp3|m4a|wav|flac|ogg|opus|aac)$/i;
export function literalMediaRef(ref: string): boolean {
  return (
    !!ref &&
    !ref.includes("\\") &&
    ![...ref].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) &&
    !ref.startsWith("/") &&
    !ref.includes("?") &&
    ref.split("/").every((part) => !!part && part !== "." && part !== "..")
  );
}
export function playbackEligible(record: InventoryRecordItem): boolean {
  const item = record.variants[0]?.item,
    media = item?.media;
  return (
    !record.conflictingLatestObservations &&
    !record.variantsTruncated &&
    record.variants.length === 1 &&
    item?.kind === "media" &&
    item.processing_status === "captured_observed" &&
    !!media?.present &&
    literalMediaRef(media.ref) &&
    AV_SUFFIX.test(media.ref) &&
    Number.isSafeInteger(media.size_bytes) &&
    (media.size_bytes ?? 0) > 0
  );
}
export function inventoryScopeKey(
  sourceId: string,
  episodeId: string,
  id: string,
): string {
  return JSON.stringify([sourceId, episodeId, id]);
}
export type LocalMatch<T> =
  | { state: "matched"; file: T; mtimeDiffers: boolean }
  | {
      state: "selection_needed" | "unavailable" | "ambiguous" | "size_mismatch";
    };
// Folder input paths are literal strings. Strip only the explicitly selected
// episode folder, never decode URL escapes or search by basename.
export function matchEpisodeFile<T extends LocalFile>(
  record: InventoryRecordItem,
  files: readonly T[],
  episodeNumber: number,
): LocalMatch<T> {
  if (!playbackEligible(record)) return { state: "unavailable" };
  const media = record.variants[0].item.media!;
  const prefix = `${episodeNumber}/`;
  const candidates = files.filter(
    (file) =>
      file.webkitRelativePath.startsWith(prefix) &&
      file.webkitRelativePath.slice(prefix.length) === media.ref,
  );
  if (candidates.length > 1) return { state: "ambiguous" };
  if (!candidates.length) return { state: "selection_needed" };
  return checkFile(media, candidates[0]);
}
function checkFile<T extends LocalFile>(
  media: NonNullable<InventoryRecordItem["variants"][number]["item"]["media"]>,
  file: T,
): LocalMatch<T> {
  if (file.size !== media.size_bytes) return { state: "size_mismatch" };
  const observed = media.modified_at ? Date.parse(media.modified_at) : NaN;
  return {
    state: "matched",
    file,
    mtimeDiffers:
      Number.isFinite(observed) &&
      Math.abs(observed - file.lastModified) > 1000,
  };
}
// An individual File has no parent directory. The owner must explicitly bind it
// to the full displayed reference; this is a manual assertion, never auto-mapping.
export function matchExplicitFile<T extends LocalFile>(
  record: InventoryRecordItem,
  file: T,
  confirmedRef: string,
): LocalMatch<T> {
  if (!playbackEligible(record)) return { state: "unavailable" };
  const media = record.variants[0].item.media!;
  if (confirmedRef !== media.ref || file.name !== media.ref.split("/").at(-1))
    return { state: "selection_needed" };
  return checkFile(media, file);
}
