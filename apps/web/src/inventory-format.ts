export const inventoryStatusLabels: Record<string, string> = {
  candidate: "Candidate",
  captured_observed: "Capture observed",
  incomplete: "Incomplete",
  quarantined: "Quarantined",
  failed: "Failed",
  missing: "Missing",
  capture_required: "Capture required",
  unverified: "Unverified",
};
export const inventoryStatusNotes: Record<string, string> = {
  candidate:
    "A source candidate was recorded. Source URLs and editorial notes are omitted from this metadata-only view.",
  captured_observed:
    "Capture evidence and a file were observed. This is not a playback, codec or editorial-readiness check.",
  incomplete:
    "The collector classified this record as incomplete. The snapshot does not establish a finished capture.",
  quarantined:
    "The collector classified this record as quarantined. It is retained for inspection, not promoted into the review slate.",
  failed:
    "The collector reported a processing failure. This view does not retry or control producer jobs.",
  missing:
    "A previously referenced file was not present when observed. Retained identity does not imply deletion.",
  capture_required:
    "The source record requires a capture. This view does not schedule or control producer jobs.",
  unverified:
    "A file or record exists without sufficient capture evidence. Its media content has not been verified.",
  unknown: "The available metadata does not establish a processing state.",
};
export function inventoryTimestamp(value: string | null | undefined) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "UTC",
      }).format(date) + " UTC"
    : "Not recorded";
}
export function inventoryBytes(value: number | null | undefined) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    value < 0
  )
    return "Size not recorded";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value / 1024,
    index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${units[index]}`;
}
export function inventoryView(href: string): "slate" | "inventory" {
  return new URL(href).searchParams.get("view") === "inventory"
    ? "inventory"
    : "slate";
}
export function inventoryViewUrl(href: string, view: "slate" | "inventory") {
  const url = new URL(href);
  if (view === "inventory") url.searchParams.set("view", "inventory");
  else url.searchParams.delete("view");
  url.hash = "";
  return url.pathname + url.search;
}
