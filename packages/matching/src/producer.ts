import { findCandidatePassages, type Cue } from "./index.ts";
import type {
  AiringEvidenceInput,
  PublishedEdition,
  Render,
} from "../../shared/src/index.ts";
export interface CandidateInput {
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
  const { render, sourceFingerprint, publication } = input;
  if (!render.artifactHash || !render.mappingVerified)
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
    render.cues.some((c) => c.endMs > render.durationMs)
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
      cues: render.cues.map((c) => ({ ...c, kind: "speech" as const })),
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
