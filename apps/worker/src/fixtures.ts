import type { Episode, Clip, Render, ProducerEvent } from "@twib/shared";
// Entirely fictional metadata examples. No private clip facts, Drive IDs, media, OAuth data, or live producer claims.
export async function seedDemo(db: D1Database): Promise<void> {
  const found = await db.prepare("SELECT id FROM episodes LIMIT 1").first();
  if (found) return;
  const episode: Episode = {
    id: "ep-demo",
    number: 1,
    title: "The bigger picture",
    subtitle: "a fictional episode · local review demonstration",
    clipCount: 5,
    publishedGuid: null,
  };
  const cuts = [
    ["topic-one", "Alex Morgan", "The opening argument", "establish"],
    ["topic-two", "Sam Rivera", "A competing perspective", "challenge"],
    ["topic-three", "Taylor Reed", "How the mechanism works", "explain"],
    ["topic-four", "Jordan Ellis", "What the evidence suggests", "challenge"],
    ["topic-five", "Alex Morgan", "A question to close on", "close"],
  ];
  const statements: D1PreparedStatement[] = [
    db
      .prepare("INSERT OR IGNORE INTO episodes VALUES(?,?)")
      .bind(episode.id, JSON.stringify(episode)),
  ];
  for (const [slug, speaker, title, role] of cuts) {
    const id = `clip-${slug}`;
    const renderId = `render-${slug}-v1`;
    const attemptId = `attempt-${slug}-1`;
    const durationMs: Record<string, number> = {
      "topic-one": 120000,
      "topic-two": 45000,
      "topic-three": 75000,
      "topic-four": 60000,
      "topic-five": 105000,
    };
    const render: Render = {
      id: renderId,
      clipId: id,
      version: 1,
      title,
      durationMs: durationMs[slug],
      createdAt: "2026-10-07T12:00:00Z",
      recipeHash: "demo-not-an-artifact-fingerprint",
      artifactHash: null,
      mediaAvailable: false,
      source: {
        title: "Source context awaiting verified import",
        speaker,
        url: null,
        edition: "unverified-demo",
        recordingDate: null,
        publicationDate: null,
        retrievedAt: null,
        inMs: 0,
        outMs: durationMs[slug],
        context:
          "Entirely fictional demonstration. Names, topics, durations and timings are synthetic. Connect a verified manifest for real source context.",
      },
      mappingVerified: false,
      cues: [],
      qa: [
        {
          check: "Technical artifact",
          result: "unknown",
          method: "Private media not connected",
          checkedAt: null,
          artifactHash: null,
        },
        {
          check: "Full listening and lip-sync",
          result: "unknown",
          method: "Manual review pending",
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
    };
    const clip: Clip = {
      catalogRevision: 0,
      id,
      episodeId: episode.id,
      title,
      summary:
        "Review the argument and its surrounding qualifications before an editorial decision.",
      narrativeRole: role,
      currentRenderId: renderId,
      renderIds: [renderId],
      visibility: "visible",
      visibilityRevision: 0,
      production: {
        attemptId,
        state: "unknown",
        stage: "Awaiting producer integration",
        lastEventAt: null,
        lastProgressAt: null,
        nextExpectedAt: null,
        blocker: null,
        checkpoint: null,
        stale: false,
      },
      airing: {
        state: "unknown",
        evidence: null,
        verifiedAt: null,
        renderId: null,
      },
      render,
    };
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO clips(id,episode_id,data,active_attempt_id) VALUES(?,?,?,?)",
        )
        .bind(id, episode.id, JSON.stringify(clip), attemptId),
      db
        .prepare("INSERT OR IGNORE INTO renders(id,clip_id,data) VALUES(?,?,?)")
        .bind(renderId, id, JSON.stringify(render)),
    );
    if (slug === "topic-three") {
      const e: ProducerEvent = {
        schemaVersion: 1,
        id: "demo-event-topic-three",
        attemptId,
        clipId: id,
        sequence: 1,
        occurredAt: "2026-10-07T12:00:00Z",
        stage: "Example: waiting for source verification",
        state: "working",
        progress: true,
        nextExpectedAt: "2026-10-07T12:30:00Z",
        blocker: null,
        checkpoint: "Demonstration checkpoint only",
      };
      statements.push(
        db
          .prepare("INSERT OR IGNORE INTO producer_events VALUES(?,?,?,?,?)")
          .bind(e.id, attemptId, id, e.sequence, JSON.stringify(e)),
      );
    }
  }
  await db.batch(statements);
}
