import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { InventoryCutRequest, InventoryReadItem } from "@twib/shared";
import { InventoryCutStatus } from "../apps/web/src/inventory-cut-status";
import { InventoryBatchPanel } from "../apps/web/src/inventory-batch-panel";
import "../apps/web/src/style.css";
import "../apps/web/src/inventory.css";
const base: InventoryCutRequest = {
  requestId: "00000000-0000-4000-8000-000000000001",
  parentItemId: "item_" + "a".repeat(64),
  parentVersion: "b".repeat(64),
  reviewRevision: 3,
  state: "queued",
  code: null,
  contextRevision: null,
  proposal: null,
  spec: { kind: "first_pass" },
  parent: {
    item_id: "item_" + "a".repeat(64),
    clip_id: "original-clip",
    clip_uid: null,
    ref: "originals/long-source.mp4",
    sha256: "c".repeat(64),
    size_bytes: 5000,
    modified_at: null,
  },
  derivative: null,
};
const proposal: NonNullable<InventoryCutRequest["proposal"]> = {
  binding: "d".repeat(64),
  contextRevision: "e".repeat(64),
  requestRevision: "f".repeat(64),
  transcriptRevision: "a".repeat(64),
  sourceSha256: "c".repeat(64),
  range: { kind: "range", startSeconds: 45, endSeconds: 165 },
  rationale: "Keep the argument and its qualification together.",
  ready: false,
  approval: "unreviewed",
};
const derivative: NonNullable<InventoryCutRequest["derivative"]> = {
  clip_id: "review-child",
  parent_clip_id: "original-clip",
  source_long_clip_id: "original-clip",
  ref: "new-review/synthetic-review-version.mp4",
  sha256: "b".repeat(64),
  source_sha256: "c".repeat(64),
  size_bytes: 1000,
  duration_seconds: 120,
  local_in_seconds: 45,
  local_out_seconds: 165,
  ready: false,
  approval: "unreviewed",
};
function Fixture() {
  const [gate, setGate] = useState(false),
    [found, setFound] = useState("");
  const states: InventoryCutRequest[] = [
    {
      ...base,
      requestId: base.requestId.slice(0, -2) + "10",
      state: "queued",
      spec: { kind: "editorial", guidance: "Preserve the qualification" },
    },
    {
      ...base,
      requestId: base.requestId.slice(0, -2) + "11",
      state: "running",
      spec: { kind: "editorial", guidance: "Preserve the qualification" },
    },
    {
      ...base,
      requestId: base.requestId.slice(0, -1) + "8",
      state: "needs_review",
      proposal,
      transitionCode: "PLAN_CONFLICT",
    },
    base,
    { ...base, requestId: base.requestId.slice(0, -1) + "2", state: "running" },
    {
      ...base,
      requestId: base.requestId.slice(0, -1) + "3",
      state: "needs_review",
      code: "EDITORIAL_PROPOSAL_READY",
      proposal,
      contextRevision: proposal.contextRevision,
    },
    {
      ...base,
      requestId: base.requestId.slice(0, -1) + "4",
      sourcePlanRequestId: base.requestId.slice(0, -1) + "3",
      spec: proposal.range,
      state: "running",
    },
    {
      ...base,
      requestId: base.requestId.slice(0, -1) + "5",
      sourcePlanRequestId: base.requestId.slice(0, -1) + "3",
      spec: proposal.range,
      state: "succeeded",
      derivative,
    },
    {
      ...base,
      requestId: base.requestId.slice(0, -1) + "6",
      state: "blocked",
      code: "CONTEXT_MISSING",
    },
    {
      ...base,
      requestId: base.requestId.slice(0, -1) + "7",
      state: "failed",
      code: "SOURCE_CHANGED",
    },
  ];
  return (
    <main>
      <button onClick={() => setGate(!gate)}>Toggle fixture gates</button>
      <InventoryBatchPanel
        items={
          [
            {
              id: "item_" + "9".repeat(64),
              filename: "oversized-source.mp4",
              review: { revision: 0, version: "b".repeat(64) },
              variants: [
                {
                  item: {
                    media: {
                      ref: "originals/oversized-source.mp4",
                      present: true,
                      duration_seconds: 900,
                      size_bytes: 512 * 1024 * 1024 + 1,
                    },
                  },
                },
              ],
            },
          ] as InventoryReadItem[]
        }
        scope={{ owner: "fixture-owner", source: "source", episode: "episode" }}
        blockedIds={[]}
        csrfToken="fixture"
        planningEnabled={gate}
        executionEnabled={gate}
        autoRenderEnabled={gate}
        onSaved={() => {}}
      />
      <p role="status">
        {found ? "Inventory lookup: " + found : "No version selected"}
      </p>
      {states.map((cut) => (
        <InventoryCutStatus
          key={cut.requestId}
          cut={cut}
          onFindDerivative={setFound}
        />
      ))}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
