// Owner-read inventory metadata. These records do not establish playable media.
export const INVENTORY_STATUSES = [
  "candidate",
  "capture_required",
  "failed",
  "captured_observed",
  "unverified",
  "incomplete",
  "missing",
  "quarantined",
] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];
export const INVENTORY_GROUPS = [
  "all",
  "media",
  "research",
  "attention",
] as const;
export type InventoryGroup = (typeof INVENTORY_GROUPS)[number];
export type InventoryReviewStatus =
  "unreviewed" | "approved" | "rejected" | "cut_down";
export interface InventoryProducerRecord {
  clip_id: string;
  clip_uid?: string | null;
  record_kind: "manual-layout" | "processing-history" | "capture-job";
  first_seen_at: string | null;
  source_signature: string | null;
  parent_clip_id: string | null;
}
export interface InventoryReview {
  status: InventoryReviewStatus;
  effectiveStatus: InventoryReviewStatus;
  notes: string;
  reason: string;
  revision: number;
  version: string;
  changed: boolean;
  savedAt: string | null;
}
export interface InventoryReviewInput {
  operationId: string;
  episodeNumber: number;
  itemId: string;
  expectedRevision: number;
  expectedVersion: string;
  action: "note" | "decision";
  notes: string;
  status?: InventoryReviewStatus;
  reason?: string;
}

export interface InventorySourceItem {
  producer_record?: InventoryProducerRecord;
  id: string;
  kind: "candidate" | "media";
  media: null | {
    ref: string;
    present: boolean;
    size_bytes: number | null;
    modified_at: string | null;
    duration_seconds: number | null;
  };
  observations: {
    artifact: string | null;
    status: string;
    context: Record<string, string>;
    timestamps: Record<string, string>;
    capture_method?: "yt-dlp" | "browser-network";
    provider?: "karakeep" | "pinboard";
    failure_classes?: string[];
    metrics?: Record<string, number>;
  }[];
  origins: { id: string; url: string }[];
  processing_status: string;
  ready: false;
  capture_evidence?: {
    artifact: string | null;
    matches_observed_size: boolean;
    content_hash_verified: false;
    streams_reprobed: false;
    producer_sha256?: string;
  }[];
}

export interface InventoryReceiptView {
  schema: "number-one-inventory-receipt/v2";
  source_id: string;
  episode_id: string;
  digest: string;
  scan_id: string;
  sequence: number;
  receipt_id: string;
  accepted_at: string;
  stored_item_count: number;
  complete: boolean;
  scope: string;
  allow_deletions: false;
  candidate_coverage: "partial";
  observedAt: string;
  scanFinishedAt: string;
}

export interface InventoryReadItem {
  identityConflict?: boolean;
  folder?: string;
  filename?: string;
  firstObservedAt?: string | null;
  firstReceivedAt?: string | null;
  producerRecord?: InventoryProducerRecord;
  review?: InventoryReview;
  id: string;
  readiness: "not_evaluated";
  conflictingLatestObservations: boolean;
  variantsTruncated: boolean;
  variants: {
    receiptId: string;
    sequence: number;
    observedAt: string;
    receivedAt: string;
    receiptComplete: boolean;
    receiptScope: string;
    item: InventorySourceItem;
  }[];
}

export interface InventoryResponse {
  sourceId: string;
  episodeId: string;
  episodeNumber: number | null;
  candidateCoverage: "partial";
  // This is only the explicit receiver gate, not a claim of active collection.
  ingestion: "disabled" | "enabled";
  ingestionPaused: boolean;
  identityCaveat: string;
  filters: {
    sort?: "identity" | "filename" | "first_observed";
    direction?: "asc" | "desc";
    review?: "all" | "unreviewed" | "approved" | "rejected" | "cut_down";
    group: InventoryGroup;
    status: InventoryStatus | null;
    query: string;
  };
  summary: {
    totalItems: number;
    matchedItems: number;
    statusCounts: Record<InventoryStatus, number>;
    groupCounts: Record<InventoryGroup, number>;
  };
  // Receipt arrival time and source clock time have different meanings.
  latestReceivedAt: string | null;
  latestObservedAt: string | null;
  latestReceipt: InventoryReceiptView | null;
  items: InventoryReadItem[];
  recentReceipts: InventoryReceiptView[];
  nextCursor: string | null;
}
