import type { Production } from "@twib/shared";
/** A source blocker/terminal failure takes precedence over stale telemetry. */
export function productionLabel(production: Production): string {
  if (production.blocker || production.state === "blocked") return "Blocked";
  if (production.state === "failed") return "Failed";
  if (production.state === "cancelled") return "Cancelled";
  if (production.stale) return "Stale · status unknown";
  if (production.state === "ready") return "Ready for review";
  if (production.state === "unknown") return "Status unknown";
  return production.state === "working" ? "In production" : "Queued";
}
export function canSeekMedia(
  mappingVerified: boolean,
  mediaAvailable: boolean,
  metadataReady: boolean,
  mediaError: string,
): boolean {
  return mappingVerified && mediaAvailable && metadataReady && !mediaError;
}
