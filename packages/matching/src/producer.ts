import { findCandidatePassages, type Cue } from "./index.ts";
import type {
  AiringEvidenceInput,
  PublishedEdition,
  Render,
} from "../../shared/src/index.ts";
import type { RenderTranscriptAsset } from "../../shared/src/render-transcripts.ts";
export interface CandidateInput {
  sourceTranscriptAsset?: RenderTranscriptAsset | null;
  render: Render;
  sourceFingerprint: string;
  publication: {
    edition: PublishedEdition;
    coordinateSpace: "published_episode";
    cues: Cue[];
  } | null;
}
/** Offline producer only. No network, authentication, storage or confirmation. */
export function produceAiringCandidate(
  input: CandidateInput,
  idempotencyKey: string,
): AiringEvidenceInput {
  const {
    render,
    sourceFingerprint,
    publication,
    sourceTranscriptAsset: asset,
  } = input;
  if (
    asset &&
    (asset.renderId !== render.id ||
      asset.mediaSha256 !== render.artifactHash ||
      asset.durationMs !== render.durationMs ||
      asset.coordinateSpace !== "clip_render" ||
      asset.alignment !== "exact_render" ||
      asset.origin !== "machine_asr" ||
      asset.textAccuracy !== "unverified" ||
      asset.sourceMapping !== "unknown" ||
      !/^[a-f0-9]{64}$/.test(asset.assetHash) ||
      !/^[a-f0-9]{64}$/.test(asset.transcriptHash))
  )
    throw new Error("Exact render transcript asset identity is invalid.");
  const cues = asset?.cues ?? render.cues;
  if (!render.artifactHash || (!render.mappingVerified && !asset))
    throw new Error(
      "An exact render hash and verified render-relative transcript mapping are required.",
    );
  if (!publication?.edition.episodeId || !publication.edition.transcriptHash)
    throw new Error(
      "A current mapped publication transcript is required. Missing data means unknown; no evidence is submitted.",
    );
  if (
    !/^[a-f0-9]{64}$/.test(sourceFingerprint) ||
    !/^[a-f0-9]{64}$/.test(render.artifactHash)
  )
    throw new Error("Exact source/render fingerprints are required.");
  if (publication.coordinateSpace !== "published_episode")
    throw new Error("Published episode coordinates are required.");
  if (
    ![
      publication.edition.editionFingerprint,
      publication.edition.transcriptHash,
      ...(publication.edition.transcriptNormalizedHash
        ? [publication.edition.transcriptNormalizedHash]
        : []),
    ].every((value) => /^[a-f0-9]{64}$/.test(value))
  )
    throw new Error(
      "Publication fingerprints must identify exact observed editions.",
    );
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(idempotencyKey))
    throw new Error("A bounded idempotency key is required.");
  if (
    !Number.isSafeInteger(render.durationMs) ||
    render.durationMs <= 0 ||
    cues.some((c) => c.endMs > render.durationMs) ||
    (asset &&
      cues.some(
        (c, i) =>
          !Number.isSafeInteger(c.startMs) ||
          !Number.isSafeInteger(c.endMs) ||
          c.startMs < 0 ||
          c.endMs <= c.startMs ||
          (i > 0 && c.startMs < cues[i - 1].endMs),
      ))
  )
    throw new Error(
      "Render-relative cues must stay within the exact render duration.",
    );
  const evidence = findCandidatePassages(
    {
      edition: {
        mediaFingerprint: render.artifactHash,
        transcriptFingerprint: sourceFingerprint,
      },
      coordinateSpace: "clip_render",
      cues: cues.map((c) => ({ ...c, kind: "speech" as const })),
    },
    {
      edition: {
        mediaFingerprint: null,
        metadataFingerprint: publication.edition.editionFingerprint,
        transcriptFingerprint:
          publication.edition.transcriptNormalizedHash ??
          publication.edition.transcriptHash,
      },
      coordinateSpace: "published_episode",
      cues: publication.cues,
    },
  );
  return {
    idempotencyKey,
    renderId: render.id,
    episodeId: publication.edition.episodeId,
    renderArtifactHash: render.artifactHash,
    sourceFingerprint,
    ...(asset
      ? {
          sourceTranscriptAssetId: asset.id,
          sourceTranscriptAssetHash: asset.assetHash,
        }
      : {}),
    episodeEditionFingerprint: publication.edition.editionFingerprint,
    episodeTranscriptHash: publication.edition.transcriptHash,
    algorithmVersion: evidence.algorithmVersion,
    status: evidence.status,
    reason: evidence.reason,
    sourceCoordinateSpace: "clip_render",
    exactRenderIdentity: "not_established_by_text",
    searchComplete: evidence.searchComplete && evidence.passages.length <= 20,
    passages: evidence.passages.slice(0, 20),
  };
}
