import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { InventoryPanel } from "../apps/web/src/inventory-panel";
import { api } from "../apps/web/src/api";
import "../apps/web/src/style.css";
// This fixture is bundled only by the offline browser harness, never production.
const test = window as unknown as {
  TEST_BYTES: string;
  AUDIO_BYTES: string;
  result?: unknown;
  toggle?: () => void;
  previewReady?: boolean;
  resumePreview?: boolean;
};
const bytes = Uint8Array.from(atob(test.TEST_BYTES), (c) => c.charCodeAt(0));
const audioBytes = Uint8Array.from(atob(test.AUDIO_BYTES), (c) =>
  c.charCodeAt(0),
);
const assertions: string[] = [],
  created: string[] = [],
  revoked: string[] = [];
const create = URL.createObjectURL.bind(URL),
  revoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (file) => {
  const url = create(file);
  created.push(url);
  return url;
};
URL.revokeObjectURL = (url) => {
  revoked.push(url);
  revoke(url);
};
const id = "item_" + "1".repeat(64),
  episodeId = "episode_" + "2".repeat(64);
const reference = "new-review/café%20literal.mp4";
const media = {
  ref: reference,
  present: true,
  size_bytes: bytes.length,
  modified_at: null,
  duration_seconds: 3,
};
const item = {
  id,
  readiness: "not_evaluated",
  conflictingLatestObservations: false,
  variantsTruncated: false,
  variants: [
    {
      sequence: 3,
      receiptId: "synthetic",
      observedAt: "2026-10-13T00:00:00Z",
      receivedAt: "2026-10-13T00:00:00Z",
      receiptComplete: false,
      receiptScope: "episode_media_and_allowlisted_local_artifacts",
      item: {
        id,
        kind: "media",
        media,
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
  identityCaveat: "Synthetic fixture",
  filters: { group: "media", status: null, query: "" },
  summary: {
    totalItems: 1,
    matchedItems: 1,
    statusCounts: { captured_observed: 1 },
    groupCounts: { media: 1, attention: 0, research: 0, all: 1 },
  },
  latestReceivedAt: null,
  latestObservedAt: null,
  latestReceipt: null,
  items: [item],
  recentReceipts: [],
  nextCursor: null,
};
let calls = 0;
api.inventory = async () => {
  calls++;
  return structuredClone(fixture) as unknown as Awaited<
    ReturnType<typeof api.inventory>
  >;
};
function check(condition: unknown, name: string) {
  if (!condition) throw Error(name);
  assertions.push(name);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => unknown) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await sleep(50);
  }
  throw Error("Timed out: " + fn.toString());
}
function button(text: string) {
  return [...document.querySelectorAll("button")].find(
    (e) => e.textContent === text,
  )!;
}
function file(
  path: string,
  size = path.endsWith(".mp3") ? audioBytes.length : bytes.length,
) {
  const data = path.endsWith(".mp3") ? audioBytes : bytes;
  const f = new File(
    [size === data.length ? data : new Uint8Array(size)],
    path.split("/").at(-1)!,
    { type: "video/mp4", lastModified: 0 },
  );
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
}
function select(files: File[]) {
  const input = document.querySelector<HTMLInputElement>(
    "input[webkitdirectory]",
  )!;
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function player() {
  return document.querySelector<HTMLVideoElement>(
    ".inventory-local-player video",
  );
}
async function refresh() {
  const before = calls;
  button("Refresh stored records").click();
  await until(
    () => calls > before && !button("Refresh stored records").disabled,
  );
  await sleep(100);
}
function Fixture() {
  const [active, setActive] = useState(true);
  test.toggle = () => setActive((value) => !value);
  return <InventoryPanel active={active} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
void (async () => {
  let error: string | undefined;
  try {
    await until(() => document.querySelector(".inventory-record"));
    document.querySelector<HTMLDetailsElement>(".inventory-record")!.open =
      true;
    check(
      !!document.querySelector("input[webkitdirectory]"),
      "directory selection API present",
    );
    check(
      button("Play selected local file").disabled,
      "selection required initially",
    );
    for (const [path, size, name] of [
      ["127/wrong/café%20literal.mp4", bytes.length, "basename never maps"],
      ["128/" + reference, bytes.length, "wrong episode rejected"],
      ["127/" + reference, 1, "size mismatch rejected"],
    ] as const) {
      select([file(path, size)]);
      await sleep(100);
      check(button("Play selected local file").disabled, name);
    }
    select([file("127/" + reference), file("127/" + reference)]);
    await sleep(100);
    check(
      button("Play selected local file").disabled,
      "duplicate exact paths rejected",
    );
    select([file("127/" + reference)]);
    await sleep(100);
    check(
      !button("Play selected local file").disabled,
      "literal percent and Unicode map",
    );
    button("Play selected local file").click();
    await until(() => (player()?.readyState ?? 0) >= 1);
    check(
      Number.isFinite(player()!.duration) && player()!.duration > 0,
      "synthetic MP4 decoded",
    );
    player()!.currentTime = 1;
    await until(() => Math.abs(player()!.currentTime - 1) < 0.1);
    const original = player()!.src;
    const note = document.querySelector<HTMLTextAreaElement>(
      ".inventory-review-editor textarea",
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(note, "Synthetic unsaved row draft");
    note.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(100);
    test.previewReady = true;
    if (!navigator.userAgent.includes("Firefox"))
      await until(() => test.resumePreview);
    test.toggle!();
    await sleep(100);
    check(
      player()!.src === original && player()!.paused,
      "hidden view keeps player paused",
    );
    test.toggle!();
    await sleep(100);
    check(
      player()!.src === original && Math.abs(player()!.currentTime - 1) < 0.1,
      "view toggle preserves playhead",
    );
    item.variants[0].sequence++;
    await refresh();
    check(player()!.src === original, "unchanged refresh keeps object URL");
    check(
      Math.abs(player()!.currentTime - 1) < 0.1,
      "refresh preserves playback position",
    );
    check(
      document.querySelector<HTMLTextAreaElement>(
        ".inventory-review-editor textarea",
      )!.value === "Synthetic unsaved row draft",
      "refresh preserves draft",
    );
    fixture.items = [];
    await refresh();
    check(player()!.src === original, "partial omission keeps player");
    fixture.items = [item];
    media.size_bytes++;
    await refresh();
    check(!player(), "changed observation stops playback");
    check(revoked.includes(original), "changed observation revokes URL");
    check(
      document.querySelector<HTMLTextAreaElement>(
        ".inventory-review-editor textarea",
      )!.value === "Synthetic unsaved row draft",
      "invalidated selection keeps draft",
    );
    media.size_bytes--;
    await refresh();
    document.querySelector<HTMLDetailsElement>(".inventory-record")!.open =
      true;
    button("Play selected local file").click();
    await until(() => (player()?.readyState ?? 0) >= 1);
    Object.defineProperty(player()!, "error", {
      configurable: true,
      value: { code: 4 },
    });
    player()!.dispatchEvent(new Event("error"));
    await sleep(100);
    check(
      document
        .querySelector(".inventory-local-player")!
        .textContent!.includes("cannot decode"),
      "codec support distinct from capture failure",
    );
    const last = player()!.src;
    button("Close local player").click();
    await sleep(100);
    check(revoked.includes(last), "close revokes URL");
    button("Play selected local file").click();
    await until(() => (player()?.readyState ?? 0) >= 1);
    fixture.sourceId = "another:source";
    await refresh();
    check(!player(), "scope change closes playback");
    check(
      created.every((url) => revoked.includes(url)),
      "all released URLs revoked",
    );
    fixture.sourceId = "nomad:number-one";
    media.ref = "new-review/tone.mp3";
    media.size_bytes = audioBytes.length;
    await refresh();
    select([file("127/new-review/tone.mp3")]);
    await sleep(100);
    document.querySelector<HTMLDetailsElement>(".inventory-record")!.open =
      true;
    button("Play selected local file").click();
    await until(
      () =>
        (document.querySelector<HTMLAudioElement>(
          ".inventory-local-player audio",
        )?.readyState ?? 0) >= 1,
    );
    check(
      document.querySelector<HTMLAudioElement>(".inventory-local-player audio")!
        .duration > 0,
      "synthetic audio-only fallback decoded",
    );
    button("Close local player").click();
    await sleep(100);
    check(
      created.every((url) => revoked.includes(url)),
      "audio URL also revoked",
    );
  } catch (e) {
    error = String(e);
  }
  const result = {
    browser: navigator.userAgent,
    assertions,
    error: error ?? null,
    created: created.length,
    revoked: revoked.length,
    fixtureOnly: true,
  };
  test.result = result;
  const pre = document.createElement("pre");
  pre.id = "qa-result";
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.prepend(pre);
  const a = document.createElement("a");
  a.href = create(
    new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
  );
  a.download = "local-playback-report.json";
  a.click();
})();
