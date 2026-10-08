/** Candidate evidence is not proof of exact rendered media use. */
export interface AiringPassage {
  sourceRange: { startMs: number; endMs: number };
  episodeRange: { startMs: number; endMs: number };
  timingPrecision: "enclosing_cues";
  quality: "exact_normalized_passage" | "near_normalized_passage";
  matchedTokens: number;
  editedTokens: number;
  distinctiveTokens: number;
  ambiguity: "multiple_locations" | "not_detected";
  sourceExcerpt: string;
  episodeExcerpt: string;
}
export interface AiringEvidenceInput {
  idempotencyKey: string;
  renderId: string;
  episodeId: string;
  renderArtifactHash: string;
  sourceFingerprint: string;
  sourceTranscriptAssetId?: string;
  sourceTranscriptAssetHash?: string;
  episodeEditionFingerprint: string;
  episodeTranscriptHash: string;
  algorithmVersion: "bounded-passage-v1";
  status: "CANDIDATE" | "UNKNOWN";
  reason:
    | "passages_require_verification"
    | "transcript_unavailable"
    | "no_distinctive_match"
    | "search_limit_reached";
  sourceCoordinateSpace: "clip_render";
  exactRenderIdentity: "not_established_by_text";
  searchComplete: boolean;
  passages: AiringPassage[];
}
export interface AiringDecisionInput {
  expectedRevision: number;
  idempotencyKey: string;
  decision: "full" | "partial" | "unknown" | "undo";
  note: string;
  /** Human must explicitly verify playback, not just matching words. */
  verification: "listened_compared_exact_render" | "none";
}
export interface AiringEvidence extends Omit<
  AiringEvidenceInput,
  "idempotencyKey"
> {
  id: string;
  revision: number;
  createdAt: string;
  decision: "full" | "partial" | "unknown";
  note: string;
  verifiedAt: string | null;
  freshness: "current" | "stale";
  staleReason: string | null;
}
export interface AiringEvidenceList {
  renderId: string;
  sourceFingerprint: string;
  evidence: AiringEvidence[];
  matching: "offline_candidate_ingestion";
  exactRenderIdentity: "requires_owner_verification";
}
