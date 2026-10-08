/** Public publication metadata is not proof that a particular render aired. */
export type PublicationAssetKind = "rss" | "transcript" | "chapters";
export interface PublicationAssetStatus {
  state: "missing" | "ready" | "blocked" | "error";
  checkedAt: string | null;
  fetchedAt: string | null;
  hash: string | null;
  error: string | null;
  nextRetryAt: string | null;
  failureCount: number;
}
export interface PublishedEdition {
  feedId: string;
  guid: string;
  episodeId: string | null;
  episodeNumber: number | null;
  title: string;
  publishedAt: string | null;
  editionFingerprint: string;
  transcriptHash: string | null;
  transcriptNormalizedHash: string | null;
  chaptersHash: string | null;
  /** Enclosure URL/length are not a fingerprint of media bytes. */
  mediaFingerprint: null;
}
export interface PublicationStatus {
  configured: boolean;
  rollover: {
    enabled: boolean;
    issue: string | null;
    lastCompletedAt: string | null;
  };
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastScheduledSuccessAt: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  latest: PublishedEdition | null;
  assets: Record<PublicationAssetKind, PublicationAssetStatus>;
}
