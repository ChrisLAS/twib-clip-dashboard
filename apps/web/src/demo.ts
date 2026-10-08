import type { EpisodeDetail, Clip } from "@twib/shared";
// Entirely fictional, metadata-only examples safe for the public source repository.
// No source frames, real episode preparation, media, transcripts or personal decisions.
const entries = [
  [
    "one",
    "Alex Morgan",
    "The liquidity question",
    "Sample Studio",
    69000,
    "A fictional opening argument for testing the editorial review workflow.",
  ],
  [
    "two",
    "Jordan Lee",
    "Reading market signals",
    "Sample Briefing",
    41000,
    "A contrasting perspective, included only to demonstrate source context.",
  ],
  [
    "three",
    "Taylor Quinn",
    "A different policy response",
    "Sample Conversation",
    117000,
    "An example of an explanatory middle section in a review slate.",
  ],
  [
    "four",
    "Casey Rivers",
    "The investment cycle",
    "Sample Studio",
    56000,
    "A fictional candidate that gives the editor another angle to consider.",
  ],
  [
    "five",
    "Avery Chen",
    "Connecting the mechanics",
    "Sample Conversation",
    110000,
    "A sample closing argument, ready for a demonstration decision.",
  ],
] as const;
export const demoEpisode: EpisodeDetail = {
  id: "ep-demo",
  number: 1,
  title: "The Bigger Picture",
  subtitle: "Fictional demonstration slate",
  clipCount: 5,
  publishedGuid: null,
  catalogVersion: 0,
  observedAt: "2026-01-01T00:00:00Z",
  sync: { lastSuccessAt: null, lastError: null },
  clips: entries.map(
    ([id, speaker, title, publisher, durationMs, summary]): Clip => ({
      id: `clip-topic-${id}`,
      episodeId: "ep-demo",
      catalogRevision: 0,
      title,
      summary,
      narrativeRole: "Suggested",
      currentRenderId: `render-topic-${id}-v1`,
      renderIds: [`render-topic-${id}-v1`],
      visibility: "visible",
      visibilityRevision: 0,
      production: {
        attemptId: null,
        state: "unknown",
        stage: "Fictional demonstration",
        lastEventAt: null,
        lastProgressAt: null,
        nextExpectedAt: null,
        blocker: null,
        checkpoint: null,
        stale: true,
      },
      airing: {
        state: "unknown",
        evidence: null,
        verifiedAt: null,
        renderId: null,
      },
      render: {
        id: `render-topic-${id}-v1`,
        clipId: `clip-topic-${id}`,
        version: 1,
        title,
        durationMs,
        createdAt: "2026-01-01T00:00:00Z",
        recipeHash: "demo-only",
        artifactHash: null,
        mediaAvailable: false,
        proxyAvailable: false,
        driveUrl: null,
        mappingVerified: false,
        cues: [],
        qa: [
          {
            check: "Playback and lip-sync",
            result: "unknown",
            method: "No media connected to this fictional example",
            checkedAt: null,
            artifactHash: null,
          },
        ],
        review: {
          decision: "clear",
          revision: 0,
          note: "",
          reason: "",
          updatedAt: null,
        },
        source: {
          speaker,
          title: publisher,
          url: null,
          edition: "Fictional demo metadata",
          recordingDate: null,
          publicationDate: null,
          retrievedAt: null,
          inMs: 0,
          outMs: durationMs,
          context: summary,
        },
      },
    }),
  ),
};
export function thumbnail(clip: Clip) {
  const n =
    ["one", "two", "three", "four", "five"].find((x) => clip.id.endsWith(x)) ||
    "one";
  return `/demo/${n}.svg`;
}
