import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { InventoryPanel } from "../apps/web/src/inventory-panel";
import { api } from "../apps/web/src/api";
import type { InventoryResponse, InventoryReviewInput } from "@twib/shared";
import "../apps/web/src/style.css";
import type { InventoryReview } from "@twib/shared";
const id = "item_" + "a".repeat(64),
  episodeId = "episode_" + "b".repeat(64),
  ref = "01-MACO/café%20literal.mp4";
const review: InventoryReview = {
  status: "unreviewed",
  effectiveStatus: "unreviewed",
  notes: "",
  reason: "",
  revision: 0,
  version: "c".repeat(64),
  changed: false,
  savedAt: null,
};
const record = {
  id,
  folder: "01-MACO",
  filename: "café%20literal.mp4",
  firstObservedAt: "2026-10-08T16:03:06Z",
  readiness: "not_evaluated",
  conflictingLatestObservations: false,
  variantsTruncated: false,
  review,
  variants: [
    {
      receiptId: "fixture",
      sequence: 1,
      observedAt: "2026-10-13T00:00:00Z",
      receivedAt: "2026-10-13T00:01:00Z",
      receiptComplete: false,
      receiptScope: "fixture",
      item: {
        id,
        kind: "media",
        media: {
          ref,
          present: true,
          size_bytes: 3,
          modified_at: null,
          duration_seconds: 600,
        },
        observations: [],
        origins: [],
        processing_status: "captured_observed",
        ready: false,
      },
    },
  ],
};
const fixture = {
  cutRequestsEnabled: true,
  cutExecutionEnabled: false,
  sourceId: "nomad:number-one",
  episodeId,
  episodeNumber: 127,
  candidateCoverage: "partial",
  ingestion: "disabled",
  ingestionPaused: true,
  identityCaveat: "Fixture",
  filters: { group: "media", status: null, query: "" },
  summary: {
    totalItems: 1,
    matchedItems: 1,
    statusCounts: { captured_observed: 1 },
    groupCounts: { all: 1, media: 1, research: 0, attention: 0 },
  },
  latestReceivedAt: null,
  latestObservedAt: null,
  latestReceipt: null,
  items: [record],
  recentReceipts: [],
  nextCursor: null,
};

const state = {
  reads: [] as { number: number; signal?: AbortSignal }[],
  writes: [] as InventoryReviewInput[],
  hold: false,
  mismatch: false,
  release: undefined as (() => void) | undefined,
};
Object.assign(window, { episodeTest: state });
api.inventory = async (input, signal) => {
  state.reads.push({ number: input.episodeNumber, signal });
  if (state.hold) {
    state.hold = false;
    await new Promise<void>((resolve) => {
      state.release = resolve;
    });
  }
  const number = state.mismatch ? 127 : input.episodeNumber;
  return structuredClone({
    ...fixture,
    episodeNumber: number,
    episodeId: "episode_" + String(number).padStart(64, "0"),
    items: [
      {
        ...record,
        filename: `clip-${number}.mp4`,
        variants: [
          {
            ...record.variants[0],
            item: {
              ...record.variants[0].item,
              media: {
                ...record.variants[0].item.media,
                ref: `clip-${number}.mp4`,
              },
            },
          },
        ],
      },
    ],
  }) as InventoryResponse;
};
api.inventoryReview = async (body) => {
  state.writes.push(body);
  return {
    ...review,
    notes: body.notes,
    revision: body.expectedRevision + 1,
    status: body.status ?? "unreviewed",
    effectiveStatus: body.status ?? "unreviewed",
  };
};
function Fixture() {
  const [number, setNumber] = useState<number | null>(127);
  const [owner, setOwner] = useState("fixture-owner");
  return (
    <>
      <button onClick={() => setNumber(127)}>Workspace 127</button>
      <button onClick={() => setNumber(128)}>Workspace 128</button>
      <button onClick={() => setNumber(null)}>No workspace</button>
      <button onClick={() => setOwner("other-owner")}>Other owner</button>
      <InventoryPanel
        episodeNumber={number}
        owner={owner}
        active
        csrfToken="fixture-csrf"
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
