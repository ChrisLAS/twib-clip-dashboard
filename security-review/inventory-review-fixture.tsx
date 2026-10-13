import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { InventoryPanel } from "../apps/web/src/inventory-panel";
import { api } from "../apps/web/src/api";
import type { InventoryResponse, InventoryReview } from "@twib/shared";
import "../apps/web/src/style.css";
const test = window as unknown as {
  TEST_BYTES: string;
  result?: unknown;
  previewReady?: boolean;
  resumePreview?: boolean;
};
const bytes = Uint8Array.from(atob(test.TEST_BYTES), (c) => c.charCodeAt(0));
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
          size_bytes: bytes.length,
          modified_at: null,
          duration_seconds: 60,
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
let reads = 0,
  writes = 0;
const inputs: unknown[] = [];
let holdSave = false,
  failSave = false;
let releaseSave: (() => void) | undefined;
api.inventory = async (input) => {
  reads++;
  inputs.push(input);
  return structuredClone({
    ...fixture,
    filters: { ...fixture.filters, review: input.review },
    items:
      input.review &&
      input.review !== "all" &&
      review.effectiveStatus !== input.review
        ? []
        : [record],
  }) as unknown as InventoryResponse;
};
api.inventoryReview = async (body, csrf) => {
  if (holdSave) {
    holdSave = false;
    await new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
  }
  if (failSave) {
    failSave = false;
    throw Error("Synthetic failed save");
  }
  if (
    csrf !== "fixture-csrf" ||
    body.itemId !== id ||
    body.expectedVersion !== review.version ||
    body.expectedRevision !== review.revision
  )
    throw Error("Synthetic conflict");
  writes++;
  review.notes = body.notes;
  review.revision++;
  review.savedAt = "2026-10-13T00:02:00Z";
  if (body.action === "decision") {
    review.status = body.status!;
    review.effectiveStatus = body.status!;
    review.reason = body.reason ?? "";
    review.changed = false;
  }
  return structuredClone(review);
};
let remount: () => void;
function Fixture() {
  const [key, setKey] = useState(0);
  remount = () => setKey((v) => v + 1);
  return <InventoryPanel key={key} active csrfToken="fixture-csrf" />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => unknown) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await sleep(50);
  }
  throw Error("Timed out " + fn);
}
const assertions: string[] = [];
function check(value: unknown, name: string) {
  if (!value) throw Error(name);
  assertions.push(name);
}
function button(name: string) {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  )!;
}
function textarea(index = 0) {
  return document.querySelectorAll<HTMLTextAreaElement>(
    ".inventory-review-editor textarea",
  )[index];
}
function edit(value: string, index = 0) {
  const input = textarea(index);
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function open() {
  await until(() => document.querySelector(".inventory-record"));
  document.querySelector<HTMLDetailsElement>(".inventory-record")!.open = true;
  await sleep(80);
}
async function refresh() {
  const before = reads;
  button("Refresh stored records").click();
  await until(
    () => reads > before && !button("Refresh stored records").disabled,
  );
  await sleep(80);
}
void (async () => {
  let error: string | null = null;
  try {
    await open();
    check(
      document
        .querySelector(".inventory-folder-heading")
        ?.textContent?.includes("01-MACO"),
      "literal existing folder preserved",
    );
    check(
      (inputs[0] as { sort: string; groupFolders: boolean }).sort ===
        "filename" && (inputs[0] as { groupFolders: boolean }).groupFolders,
      "server sort and folder grouping requested",
    );
    edit("Saved owner note");
    await sleep(80);
    button("Save note").click();
    await until(
      () =>
        writes === 1 &&
        !button("Save note").disabled &&
        document
          .querySelector(".inventory-review-editor")
          ?.textContent?.includes("revision 1"),
    );
    await sleep(80);
    check(review.notes === "Saved owner note", "save note uses persistent API");
    button("Approve").click();
    await until(
      () => review.status === "approved" && !button("Approve").disabled,
    );
    await until(() =>
      document
        .querySelector(".inventory-record summary")
        ?.textContent?.includes("Approved"),
    );
    check(
      document
        .querySelector(".inventory-record summary")
        ?.textContent?.includes("Approved"),
      "persistent explicit approval visible in collapsed summary",
    );
    check(
      button("Approve").getAttribute("aria-pressed") === "true",
      "approved inventory decision has accessible selected state",
    );
    const before = reads;
    remount!();
    await until(() => reads > before);
    await open();
    check(
      textarea().value === "Saved owner note" &&
        document
          .querySelector(".inventory-record summary")
          ?.textContent?.includes("Approved"),
      "cold component reload restores note and approval from API",
    );
    const choice = (name: string) => {
      const selected = document.querySelectorAll(
        '[aria-label="Review decision choices"] button[aria-pressed="true"]',
      );
      return selected.length === 1 && selected[0] === button(name);
    };
    edit("Trim the setup; this stores a request only", 1);
    await sleep(80);
    holdSave = true;
    button("Cut down").click();
    await until(() => releaseSave && button("Cut down").disabled);
    check(
      choice("Cut down") &&
        button("Approve").getAttribute("aria-pressed") === "false",
      "approve to cut-down immediately selects only cut-down while saving",
    );
    check(
      document
        .querySelector(".inventory-review-choice-state")
        ?.textContent?.includes("Saving Cut down requested") &&
        document
          .querySelector(".inventory-record summary")
          ?.textContent?.includes("Saved: Approved") &&
        textarea().disabled,
      "pending choice is distinct from saved row and inputs are protected",
    );
    releaseSave!();
    releaseSave = undefined;
    await until(
      () => review.status === "cut_down" && !button("Cut down").disabled,
    );
    check(
      choice("Cut down") &&
        document
          .querySelector(".inventory-record summary")
          ?.textContent?.includes("Saved: Cut down requested"),
      "saved cut-down selects only its button and updates main-list text",
    );
    const badge = document.querySelector(
      ".inventory-record summary .review-cut_down",
    )!;
    check(
      getComputedStyle(badge).backgroundColor !== "rgba(0, 0, 0, 0)" &&
        Number(getComputedStyle(badge).fontWeight) >= 700,
      "cut-down main-list badge has prominent color and weight",
    );
    check(
      getComputedStyle(button("Cut down")).backgroundColor !==
        getComputedStyle(button("Approve")).backgroundColor,
      "saved cut-down alone has selected button fill",
    );
    await refresh();
    check(
      choice("Cut down") && textarea().value === "Saved owner note",
      "refresh preserves cut-down highlight and saved notes",
    );
    button("Approve").click();
    await until(
      () => review.status === "approved" && !button("Approve").disabled,
    );
    check(
      choice("Approve") &&
        button("Cut down").getAttribute("aria-pressed") === "false",
      "reverse cut-down to approve selects only approved",
    );
    await sleep(80);
    failSave = true;
    button("Cut down").click();
    await until(() =>
      document.querySelector('.inventory-review-editor [role="alert"]'),
    );
    check(
      choice("Cut down") &&
        document
          .querySelector(".inventory-review-choice-state")
          ?.textContent?.includes(
            "Unsaved choice: Cut down requested. Saved decision: Approved",
          ) &&
        document
          .querySelector(".inventory-record summary")
          ?.textContent?.includes("Saved: Approved") &&
        textarea().value === "Saved owner note",
      "failed save retains explicit unsaved choice without altering saved approval or notes",
    );
    await refresh();
    check(
      choice("Cut down") &&
        document
          .querySelector(".inventory-record summary")
          ?.textContent?.includes("Saved: Approved"),
      "refresh after failure preserves unsaved choice and truthful saved badge",
    );
    button("Reload saved review").click();
    await sleep(80);
    check(
      choice("Approve"),
      "reload saved review clears failed choice and restores approval highlight",
    );
    review.revision++;
    button("Cut down").click();
    await until(() =>
      document.querySelector('.inventory-review-editor [role="alert"]'),
    );
    await refresh();
    check(
      choice("Cut down") &&
        button("Save decision").disabled &&
        document
          .querySelector(".inventory-record summary")
          ?.textContent?.includes("Saved: Approved"),
      "conflicting decision stays unsaved and blocks overwrite after refresh",
    );
    button("Keep my draft against latest").click();
    await sleep(80);
    button("Save decision").click();
    await until(
      () => review.status === "cut_down" && !button("Cut down").disabled,
    );
    await until(
      () =>
        document
          .querySelector(".inventory-review-editor")
          ?.textContent?.includes("No file has been moved or cut") &&
        !button("Cut down").disabled,
    );
    check(
      choice("Cut down") &&
        textarea().value === "Saved owner note" &&
        document
          .querySelector(".inventory-review-editor")
          ?.textContent?.includes("No file has been moved or cut"),
      "explicit rebase saves cut-down request with notes and no job claim",
    );
    const details =
      document.querySelector<HTMLDetailsElement>(".inventory-record")!;
    details.open = false;
    await sleep(80);
    check(
      details
        .querySelector("summary")
        ?.textContent?.includes("Saved: Cut down requested"),
      "collapsed main list prominently retains cut-down request",
    );
    details.open = true;
    await sleep(80);
    const input = document.querySelector<HTMLInputElement>(
      "input[webkitdirectory]",
    )!;
    const f = new File([bytes], "café%20literal.mp4", { type: "video/mp4" });
    Object.defineProperty(f, "webkitRelativePath", { value: "127/" + ref });
    const transfer = new DataTransfer();
    transfer.items.add(f);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(80);
    button("Play selected local file").click();
    await until(
      () =>
        (document.querySelector<HTMLVideoElement>("video")?.readyState ?? 0) >=
        1,
    );
    check(
      document
        .querySelector(".inventory-local-player")
        ?.closest(".inventory-record"),
      "player resides inside expanded clip row",
    );
    check(
      textarea().closest(".inventory-record") ===
        document.querySelector("video")?.closest(".inventory-record"),
      "player and persistent notes share the same row",
    );
    const video = document.querySelector<HTMLVideoElement>("video")!,
      url = video.src;
    video.currentTime = 1;
    await sleep(100);
    test.previewReady = true;
    if (!navigator.userAgent.includes("Firefox"))
      await until(() => test.resumePreview);
    check(
      document.documentElement.scrollWidth <= window.innerWidth + 1,
      "responsive review has no horizontal overflow",
    );
    await refresh();
    check(
      document.querySelector<HTMLVideoElement>("video")?.src === url,
      "unchanged refresh preserves inline object URL",
    );
    document.querySelector<HTMLDetailsElement>(".inventory-record")!.open =
      false;
    await sleep(100);
    check(video.paused, "collapsing clip row pauses its player");
    await open();
    edit("Retained conflicting draft");
    await sleep(80);
    review.revision++;
    review.notes = "Another saved note";
    await refresh();
    check(
      textarea().value === "Retained conflicting draft" &&
        button("Save note").disabled,
      "concurrent review retains draft and blocks stale overwrite",
    );
    button("Keep my draft against latest").click();
    await sleep(80);
    button("Save note").click();
    await until(() => review.notes === "Retained conflicting draft");
    check(
      review.notes === "Retained conflicting draft",
      "explicit rebase permits saved draft",
    );
    review.version = "d".repeat(64);
    review.changed = true;
    review.effectiveStatus = "unreviewed";
    record.variants[0].item.media.size_bytes++;
    await refresh();
    check(
      document
        .querySelector(".inventory-record summary")
        ?.textContent?.includes("Unreviewed"),
      "media revision invalidates approval visibly",
    );
    check(
      !document.querySelector("video") &&
        textarea().value === "Retained conflicting draft",
      "changed selection stops playback without losing saved notes",
    );
    edit("", 1);
    await sleep(80);
    const beforeReject = writes;
    button("Reject").click();
    await sleep(100);
    check(
      writes === beforeReject &&
        document
          .querySelector('.inventory-review-editor [role="alert"]')
          ?.textContent?.includes("reason"),
      "rejection needs explanation before API write",
    );
    edit("No useful complete point", 1);
    await sleep(80);
    button("Reject").click();
    await until(() => review.status === "rejected");
    check(
      review.reason === "No useful complete point",
      "rejection persists explanation without host action",
    );
    button("Release selected local files").click();
    await sleep(80);
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Review decision"]',
    )!;
    select.value = "unreviewed";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => !document.querySelector(".inventory-record"));
    check(
      (inputs.at(-1) as { review: string }).review === "unreviewed",
      "Unreviewed filter is sent to server",
    );
  } catch (e) {
    error = String(e);
  }
  const result = {
    browser: navigator.userAgent,
    assertions,
    error,
    fixtureOnly: true,
    noHostActions: true,
  };
  test.result = result;
  const pre = document.createElement("pre");
  pre.id = "qa-result";
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.prepend(pre);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(result)], { type: "application/json" }),
  );
  a.download = "inventory-review-report.json";
  a.click();
})();
