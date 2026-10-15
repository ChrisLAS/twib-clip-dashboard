import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { InventoryBatchPanel } from "../apps/web/src/inventory-batch-panel";
import { api, RequestError } from "../apps/web/src/api";
import type {
  InventoryReadItem,
  InventoryReview,
  InventoryReviewInput,
} from "@twib/shared";
import "../apps/web/src/style.css";
import "../apps/web/src/inventory.css";
const state = window as unknown as {
  writes: InventoryReviewInput[];
  rejectNext: boolean;
};
state.writes = JSON.parse(sessionStorage.getItem("fixture-writes") ?? "[]");
state.rejectNext = false;
const items = [1, 2, 3].map((n) => ({
  id: "item_" + String(n).repeat(64),
  filename: "long-clip-" + n + ".mp4",
  identityConflict: false,
  conflictingLatestObservations: false,
  variantsTruncated: false,
  review: {
    revision: 0,
    version: "a".repeat(64),
    status: "unreviewed",
    effectiveStatus: "unreviewed",
    notes: "original note",
    reason: "",
    changed: false,
    savedAt: null,
  },
  variants: [
    {
      item: {
        media: {
          ref: "clips/long-" + n + ".mp4",
          present: true,
          duration_seconds: 600,
        },
      },
    },
  ],
})) as InventoryReadItem[];
// Synthetic server journal survives reload independently of the client outbox.
api.inventoryReview = async (input) => {
  state.writes.push(structuredClone(input));
  sessionStorage.setItem("fixture-writes", JSON.stringify(state.writes));
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (state.rejectNext) {
    state.rejectNext = false;
    throw new RequestError("Source changed", 409);
  }
  const receipts = JSON.parse(
    sessionStorage.getItem("fixture-receipts") ?? "{}",
  );
  if (receipts[input.operationId]) return receipts[input.operationId];
  const result = {
    ...items[0].review,
    revision: 1,
    effectiveStatus: "cut_down",
    cutRequest: { state: "needs_review", code: "CONTEXT_MISSING" },
  } as InventoryReview;
  receipts[input.operationId] = result;
  sessionStorage.setItem("fixture-receipts", JSON.stringify(receipts));
  if (
    input.itemId === items[1].id &&
    !sessionStorage.getItem("fixture-failed")
  ) {
    sessionStorage.setItem("fixture-failed", "true");
    throw new Error("committed but lost reply");
  }
  if (sessionStorage.getItem("fixture-hold") === input.itemId)
    await new Promise(() => {});
  return result;
};
function Fixture() {
  const [page, setPage] = useState(0),
    [stale, setStale] = useState(false),
    [blocked, setBlocked] = useState<string[]>([]),
    [owner, setOwner] = useState("fixture-owner");
  return (
    <main>
      <button onClick={() => setPage(0)}>Page one</button>
      <button onClick={() => setPage(1)}>Page two</button>
      <button onClick={() => setStale(true)}>Change source</button>
      <button onClick={() => setBlocked([items[0].id])}>
        Draft first clip
      </button>
      <button onClick={() => setOwner("other-owner")}>Change owner</button>
      <InventoryBatchPanel
        key={owner}
        scope={{
          owner,
          source: "fixture-source",
          episode: "fixture-episode",
        }}
        items={(page === 0 ? items.slice(0, 2) : items.slice(2)).map((item) =>
          stale ? { ...item, review: { ...item.review!, revision: 2 } } : item,
        )}
        csrfToken="test"
        blockedIds={blocked}
        onSaved={() => {}}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
