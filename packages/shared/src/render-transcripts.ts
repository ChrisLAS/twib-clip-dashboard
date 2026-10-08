import type { Cue } from "./index";
/** An exact-file ASR observation, never verified words or source-media mapping. */
export interface RenderTranscriptInput {
  idempotencyKey: string;
  renderId: string;
  mediaSha256: string;
  origin: "machine_asr";
  alignment: "exact_render";
  textAccuracy: "unverified";
  sourceMapping: "unknown";
  cues: Cue[];
}
export interface RenderTranscriptAsset extends Omit<
  RenderTranscriptInput,
  "idempotencyKey"
> {
  id: string;
  durationMs: number;
  coordinateSpace: "clip_render";
  transcriptHash: string;
  assetHash: string;
  createdAt: string;
}
