export type Decision = "up" | "down" | "defer" | "clear";
export type QAResult = "passed" | "failed" | "unknown";
export type ProductionState =
  | "queued"
  | "working"
  | "ready"
  | "blocked"
  | "failed"
  | "cancelled"
  | "unknown";
export interface QA {
  check: string;
  result: QAResult;
  method: string;
  checkedAt: string | null;
  artifactHash: string | null;
}
export interface Cue {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}
export interface Source {
  title: string;
  speaker: string;
  url: string | null;
  edition: string;
  recordingDate: string | null;
  publicationDate: string | null;
  retrievedAt: string | null;
  inMs: number;
  outMs: number;
  context: string;
}
export interface Review {
  decision: Decision;
  revision: number;
  note: string;
  reason: string;
  updatedAt: string | null;
}
export interface Production {
  attemptId: string | null;
  state: ProductionState;
  stage: string;
  lastEventAt: string | null;
  lastProgressAt: string | null;
  nextExpectedAt: string | null;
  blocker: string | null;
  checkpoint: string | null;
  stale: boolean;
}
export interface Airing {
  state: "unknown" | "candidate" | "confirmed" | "contradicted";
  evidence: string | null;
  verifiedAt: string | null;
  renderId: string | null;
}
export interface Render {
  id: string;
  clipId: string;
  version: number;
  title: string;
  durationMs: number;
  createdAt: string;
  recipeHash: string;
  artifactHash: string | null;
  mediaAvailable: boolean;
  proxyAvailable?: boolean;
  driveUrl?: string | null;
  source: Source;
  mappingVerified: boolean;
  cues: Cue[];
  qa: QA[];
  review: Review;
}
export interface Clip {
  id: string;
  episodeId: string;
  title: string;
  summary: string;
  narrativeRole: string;
  currentRenderId: string;
  renderIds: string[];
  visibility: "visible" | "hidden";
  visibilityRevision: number;
  production: Production;
  airing: Airing;
  render: Render;
}
export interface Episode {
  id: string;
  number: number;
  title: string;
  subtitle: string;
  clipCount: number;
  publishedGuid: string | null;
}
export interface EpisodeDetail extends Episode {
  clips: Clip[];
  sync: { lastSuccessAt: string | null; lastError: string | null };
  observedAt: string;
}
export interface ProducerEvent {
  schemaVersion: 1;
  id: string;
  attemptId: string;
  clipId: string;
  sequence: number;
  occurredAt: string;
  stage: string;
  state: ProductionState;
  progress: boolean;
  nextExpectedAt: string | null;
  blocker: string | null;
  checkpoint: string | null;
}
export interface ReviewInput {
  decision: Decision;
  note?: string;
  reason?: string;
  expectedRevision: number;
  idempotencyKey: string;
}
export interface VisibilityInput {
  visibility: "visible" | "hidden";
  expectedRevision: number;
  idempotencyKey: string;
}
export interface Session {
  csrfToken: string;
  mode: "demo" | "production";
  integrations: { drive: boolean; producer: boolean };
  owner: string;
}
export interface ApiError {
  error: { code: string; message: string };
  currentRevision?: number;
}
