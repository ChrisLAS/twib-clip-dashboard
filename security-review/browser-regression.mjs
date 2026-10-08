import {
  runWorkflowBrowserRegression,
  runPublicationBrowserRegression,
} from "./workflow-browser-regression.mjs";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
// Generated test pattern and tone only. Never a source clip or a private artifact.
const fixtureDir = await mkdtemp(join(tmpdir(), "review-synthetic-"));
const fixturePath = join(fixtureDir, "synthetic.mp4");
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=10",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=220:sample_rate=22050",
  "-t",
  "30",
  "-c:v",
  "libx264",
  "-threads",
  "1",
  "-preset",
  "veryfast",
  "-crf",
  "35",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "32k",
  "-movflags",
  "+faststart",
  fixturePath,
]);
const thumbnailPath = join(fixtureDir, "synthetic.png");
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  fixturePath,
  "-frames:v",
  "1",
  "-threads",
  "1",
  thumbnailPath,
]);
const syntheticThumbnail = await readFile(thumbnailPath);
const syntheticVideo = await readFile(fixturePath);
const syntheticHash = createHash("sha256").update(syntheticVideo).digest("hex");
await rm(fixtureDir, { recursive: true, force: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : { channel: process.env.BROWSER_CHANNEL || "chrome" }),
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  locale: "en-US",
  timezoneId: "UTC",
  reducedMotion: "reduce",
});
await mkdir("test-results", { recursive: true });
async function capture(name) {
  await page.addStyleTag({
    content:
      "*,*::before,*::after { animation:none !important; transition:none !important; caret-color:transparent !important; }",
  });
  await page.screenshot({
    path: `test-results/${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
}
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail}`);
};
const makeClip = (id) => ({
  id,
  episodeId: "ep-demo",
  catalogRevision: 1,
  title: `Clip ${id}`,
  summary: "Test fixture",
  narrativeRole: "test",
  currentRenderId: `${id}-v1`,
  renderIds: [`${id}-v1`],
  visibility: "visible",
  visibilityRevision: 0,
  production: {
    attemptId: null,
    state: "ready",
    stage: "Ready",
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
  render: {
    id: `${id}-v1`,
    clipId: id,
    version: 1,
    title: `Clip ${id}`,
    durationMs: 30000,
    createdAt: "2026-10-07T12:00:00Z",
    recipeHash: "fixture",
    artifactHash: syntheticHash,
    mediaAvailable: true,
    source: {
      title: "Source",
      speaker: `Speaker ${id}`,
      url: null,
      edition: "1",
      recordingDate: null,
      publicationDate: null,
      retrievedAt: null,
      inMs: 100000,
      outMs: 130000,
      context: "Fixture",
    },
    mappingVerified: true,
    cues: [
      { id: "cue1", text: "Second passage", startMs: 20000, endMs: 25000 },
    ],
    qa: ["artifact", "container", "codecs", "duration", "mapping"].map(
      (check) => ({
        check,
        result: "passed",
        method: "Generated synthetic fixture",
        checkedAt: "2026-01-01T00:00:00Z",
        artifactHash: syntheticHash,
      }),
    ),
    review: {
      decision: "clear",
      revision: 0,
      note: "",
      reason: "",
      updatedAt: null,
    },
  },
});
const episode = {
  id: "ep-demo",
  number: 1,
  title: "Fixture episode",
  subtitle: "",
  clipCount: 2,
  publishedGuid: null,
  clips: [makeClip("c1"), makeClip("c2")],
  catalogVersion: 1,
  sync: { lastSuccessAt: "2026-10-08T02:55:00Z", lastError: null },
  observedAt: "2026-10-07T12:00:00Z",
};
episode.clips[1].production = {
  ...episode.clips[1].production,
  state: "blocked",
  stage: "Source verification",
  blocker: "Fixture source needs verification",
  stale: true,
  lastProgressAt: "2026-01-01T12:00:00Z",
  nextExpectedAt: "2026-01-01T13:00:00Z",
};
episode.clips[1].render.qa.push({
  check: "listening",
  result: "unknown",
  method: "Fixture manual review pending",
  checkedAt: null,
  artifactHash: syntheticHash,
});
const initialEpisode = globalThis.structuredClone(episode);
const catalogStatus = {
  version: 1,
  complete: true,
  observedAt: "2026-10-08T03:00:00Z",
  sync: {
    configured: true,
    running: false,
    lastAttemptAt: "2026-10-08T02:55:00Z",
    lastSuccessAt: "2026-10-08T02:55:00Z",
    lastError: null,
    stale: false,
    intervalSeconds: 300,
  },
  clips: [],
};
function updateCatalogStatus(version) {
  catalogStatus.version = version;
  catalogStatus.clips = episode.clips.map((clip) => ({
    id: clip.id,
    episodeId: clip.episodeId,
    revision: clip.catalogRevision,
    currentRenderId: clip.currentRenderId,
  }));
  episode.catalogVersion = version;
}
updateCatalogStatus(1);
// The workspace/intake stage uses a separate, wholly fictional catalog. Keep
// the existing media, review and automatic-sync regressions unchanged.
let intakeFixtureEnabled = false;
const intakeEpisodes = [
  {
    ...globalThis.structuredClone(initialEpisode),
    id: "ep-127",
    number: 127,
    title: "Fictional upcoming episode",
    status: "draft",
    isActive: true,
    workspaceRevision: 1,
    uploadFolderUrl:
      "https://drive.google.com/drive/folders/fictional-intake-folder",
    intakeCount: 0,
    clipCount: 0,
    clips: [],
  },
  {
    ...globalThis.structuredClone(initialEpisode),
    id: "ep-126",
    number: 126,
    title: "Fictional previous episode",
    status: "published",
    isActive: false,
    workspaceRevision: 1,
    uploadFolderUrl: null,
    intakeCount: 0,
    clips: ["c126a", "c126b"].map((id) => ({
      ...makeClip(id),
      episodeId: "ep-126",
    })),
  },
];
const manualIntake = [];
const intakeWrites = [];
const operationReads = [];
const operationReceipts = new Map();
const intakeReads = [];
const workspaceReads = [];
let intakeVersion = 0;
let intakeSaveMode = "success";
let nextIntakeDuplicateMatches = null;
let heldWorkspaceId = null;
let holdIntakeReads = false;
const heldWorkspaceResponses = [];
const heldIntakeResponses = [];
const heldIntakeWrites = [];
function canonicalFixtureUrl(value) {
  const url = new URL(value);
  // Synthetic deterministic duplicate behavior, not a substitute for server
  // URL validation/canonicalization tests.
  if (url.hostname === "youtu.be")
    return `https://www.youtube.com/watch?v=${url.pathname.slice(1)}`;
  if (url.hostname === "www.youtube.com")
    return `https://www.youtube.com/watch?v=${url.searchParams.get("v")}`;
  url.hash = "";
  url.searchParams.delete("utm_source");
  return url.href;
}
async function handleIntakeFixture(route, path) {
  const req = route.request();
  if (path === "/api/episodes") {
    await fulfillApiFixture(route, {
      json: intakeEpisodes.map((entry) => ({
        ...entry,
        intakeCount: manualIntake.filter(
          (item) => item.episodeId === entry.id && item.status !== "cancelled",
        ).length,
      })),
    });
  } else if (path.startsWith("/api/episodes/")) {
    const id = decodeURIComponent(path.slice("/api/episodes/".length));
    const entry = intakeEpisodes.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unexpected fixture episode: ${id}`);
    const snapshot = globalThis.structuredClone(entry);
    workspaceReads.push(id);
    if (heldWorkspaceId === id)
      await new Promise((resolve) => heldWorkspaceResponses.push(resolve));
    await fulfillApiFixture(route, { json: snapshot });
  } else if (path === "/api/intake" && req.method() === "GET") {
    const snapshot = {
      version: intakeVersion,
      items: globalThis.structuredClone(manualIntake),
    };
    intakeReads.push(snapshot);
    if (holdIntakeReads)
      await new Promise((resolve) => heldIntakeResponses.push(resolve));
    await fulfillApiFixture(route, { json: snapshot });
  } else if (path === "/api/catalog/status") {
    statusRequests.push({ method: req.method(), body: req.postData() });
    await fulfillApiFixture(route, {
      json: {
        ...catalogStatus,
        version: 1,
        intakeVersion,
        workspaceVersion: 1,
        sync: { ...catalogStatus.sync, lastError: null },
        clips: intakeEpisodes.flatMap((entry) =>
          entry.clips.map((clip) => ({
            id: clip.id,
            episodeId: entry.id,
            revision: clip.catalogRevision,
            currentRenderId: clip.currentRenderId,
          })),
        ),
      },
    });
  } else if (path.startsWith("/api/operations/")) {
    const key = decodeURIComponent(path.slice("/api/operations/".length));
    operationReads.push(key);
    const receipt = operationReceipts.get(key);
    await fulfillApiFixture(
      route,
      receipt
        ? { json: receipt }
        : {
            status: 404,
            json: {
              error: {
                code: "NOT_FOUND",
                message: "No synthetic operation receipt",
              },
            },
          },
    );
  } else if (path.startsWith("/api/intake/") && req.method() === "POST") {
    const input = req.postDataJSON();
    intakeWrites.push({ path, input, csrf: req.headers()["x-csrf-token"] });
    const previous = operationReceipts.get(input.idempotencyKey);
    if (previous) {
      await fulfillApiFixture(route, { json: previous });
      return true;
    }
    const item = manualIntake.find(
      (candidate) =>
        candidate.id === decodeURIComponent(path.slice("/api/intake/".length)),
    );
    if (!item) throw new Error(`Unexpected fixture intake: ${path}`);
    if (input.expectedRevision !== item.revision) {
      await fulfillApiFixture(route, {
        status: 409,
        json: {
          error: {
            code: "REVISION_CONFLICT",
            message: "This submission changed elsewhere.",
          },
          currentRevision: item.revision,
        },
      });
      return true;
    }
    const next = {
      ...item,
      ...Object.fromEntries(
        ["episodeId", "inMs", "outMs", "whyItMatters"]
          .filter((key) => key in input)
          .map((key) => [key, input[key]]),
      ),
      status: input.action === "cancel" ? "cancelled" : "awaiting_processing",
    };
    const matches =
      next.status === "cancelled"
        ? []
        : manualIntake
            .filter(
              (other) =>
                other.id !== item.id &&
                other.status === "awaiting_processing" &&
                other.canonicalUrl === next.canonicalUrl,
            )
            .map((other) => ({
              kind: "intake",
              id: other.id,
              episodeId: other.episodeId,
              rangeMatch:
                other.inMs === next.inMs && other.outMs === next.outMs
                  ? "exact"
                  : "different",
            }));
    if (
      matches.some((match) => match.rangeMatch === "exact") ||
      (matches.length && !input.allowDifferentRange)
    ) {
      await fulfillApiFixture(route, {
        status: 409,
        json: {
          error: {
            code: matches.some((match) => match.rangeMatch === "exact")
              ? "DUPLICATE_INTAKE"
              : "DUPLICATE_SOURCE",
            message: "Another cut of this source is already saved.",
          },
          duplicateMatches: matches,
          existingIntakeIds: matches.map((match) => match.id),
        },
      });
      return true;
    }
    Object.assign(item, next, { revision: item.revision + 1 });
    const result = {
      intake: globalThis.structuredClone(item),
      intakeVersion: ++intakeVersion,
    };
    operationReceipts.set(input.idempotencyKey, result);
    await fulfillApiFixture(route, { json: result });
  } else if (path === "/api/intake" && req.method() === "POST") {
    const input = req.postDataJSON();
    intakeWrites.push({ path, input, csrf: req.headers()["x-csrf-token"] });
    const mode = intakeSaveMode;
    if (mode === "hold")
      await new Promise((resolve) => heldIntakeWrites.push(resolve));
    const previous = operationReceipts.get(input.idempotencyKey);
    if (previous) {
      await fulfillApiFixture(route, { json: previous });
      return true;
    }
    if (mode === "uncertain") {
      await fulfillApiFixture(route, {
        status: 503,
        json: {
          error: {
            code: "UNAVAILABLE",
            message: "Synthetic intake save interrupted",
          },
        },
      });
      return true;
    }
    if (nextIntakeDuplicateMatches) {
      const matches = nextIntakeDuplicateMatches;
      nextIntakeDuplicateMatches = null;
      await fulfillApiFixture(route, {
        status: 409,
        json: {
          error: {
            code: "DUPLICATE_INTAKE",
            message: "This synthetic source is already saved.",
          },
          duplicateMatches: matches,
          existingIntakeIds: matches
            .filter((match) => match.kind === "intake")
            .map((match) => match.id),
        },
      });
      return true;
    }
    const canonicalUrl = canonicalFixtureUrl(input.url);
    const sameSource = manualIntake.filter(
      (item) =>
        item.status !== "cancelled" && item.canonicalUrl === canonicalUrl,
    );
    const exactDuplicate = sameSource.find(
      (item) =>
        item.inMs === (input.inMs ?? null) &&
        item.outMs === (input.outMs ?? null),
    );
    const duplicate = exactDuplicate ?? sameSource[0];
    if (duplicate && (exactDuplicate || !input.allowDifferentRange)) {
      await fulfillApiFixture(route, {
        status: 409,
        json: {
          error: {
            code: exactDuplicate ? "DUPLICATE_INTAKE" : "DUPLICATE_SOURCE",
            message: "This source and range are already saved.",
          },
          existingIntakeIds: [duplicate.id],
          duplicateMatches: [
            {
              kind: "intake",
              id: duplicate.id,
              episodeId: duplicate.episodeId,
              rangeMatch: exactDuplicate ? "exact" : "different",
            },
          ],
        },
      });
      return true;
    }
    const item = {
      id: `intake-fixture-${manualIntake.length + 1}`,
      episodeId: input.episodeId,
      kind: input.kind,
      submittedUrl: input.url,
      canonicalUrl,
      provider: /youtube|youtu\.be/.test(canonicalUrl)
        ? "youtube"
        : canonicalUrl.includes("drive.google.com")
          ? "drive"
          : "other",
      inMs: input.inMs ?? null,
      outMs: input.outMs ?? null,
      whyItMatters: input.whyItMatters ?? "",
      status: "awaiting_processing",
      revision: 1,
      createdAt: "2026-10-08T03:00:00Z",
      updatedAt: "2026-10-08T03:00:00Z",
    };
    manualIntake.push(item);
    const result = { intake: item, intakeVersion: ++intakeVersion };
    operationReceipts.set(input.idempotencyKey, result);
    await fulfillApiFixture(
      route,
      mode === "committed-uncertain"
        ? {
            status: 503,
            json: {
              error: {
                code: "UNAVAILABLE",
                message: "Synthetic response lost after commit",
              },
            },
          }
        : { json: result },
    );
  } else {
    return false;
  }
  return true;
}
const requests = [];
const googleRequests = [];
const externalRequests = [];
const fixtureOrigin = new URL(
  process.env.TEST_BASE_URL || "http://127.0.0.1:5173/",
).origin;
page.on("request", (request) => {
  const requestedUrl = new URL(request.url());
  if (
    /^https?:$/.test(requestedUrl.protocol) &&
    requestedUrl.origin !== fixtureOrigin
  )
    externalRequests.push(request.url());
  if (
    /(^|\.)(googleapis|google|googleusercontent)\.com$/.test(
      new URL(request.url()).hostname,
    )
  )
    googleRequests.push(request.url());
});
const statusRequests = [];
const episodeRequests = [];
let statusFailure = false;
let holdStatusResponses = false;
let holdEpisodeResponses = false;
const heldStatusResponses = [];
const heldEpisodeResponses = [];
async function waitUntil(predicate, description) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function fulfillApiFixture(route, response) {
  try {
    await route.fulfill(response);
  } catch (error) {
    // Cancel/navigation intentionally abort fetches whose captured responses are
    // released later. Ignore only the matching browser-reported abort.
    const failure = route.request().failure();
    if (!failure || !/abort|cancel/i.test(failure.errorText)) throw error;
  }
}
async function releaseResponses(queue) {
  for (const release of queue.splice(0)) release();
  // Let the browser deliver response callbacks before asserting stale-result guards.
  await page.waitForTimeout(150);
}
async function setPageVisibility(visible) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: value ? "visible" : "hidden",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: !value,
    });
    document.dispatchEvent(new document.defaultView.Event("visibilitychange"));
  }, visible);
}
async function pollCatalog() {
  const previousCount = statusRequests.length;
  await setPageVisibility(false);
  await setPageVisibility(true);
  await waitUntil(
    () => statusRequests.length > previousCount,
    "catalog status request after visibility resumes",
  );
  await page.waitForTimeout(100);
}
async function openTroubleshooting() {
  const panel = page.locator("details.sync-troubleshooting");
  if (!(await panel.evaluate((details) => details.open)))
    await panel.locator("summary").click();
}
async function refreshSlate() {
  await page
    .locator(".episode-heading")
    .getByRole("button", { name: "Refresh slate", exact: true })
    .first()
    .click();
}
async function chooseWorkspace(id) {
  await page
    .getByRole("combobox", { name: "Episode", exact: true })
    .selectOption(id);
  await waitUntil(
    () => new URL(page.url()).searchParams.get("episode") === id,
    `episode URL changes to ${id}`,
  );
}
async function openIntake() {
  await page
    .getByRole("button", { name: "Add clip or source", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Add to your slate",
    exact: true,
  });
  await dialog.waitFor();
  return dialog;
}
async function fillIntake(
  dialog,
  {
    url,
    kind = "full_source",
    start = "1:02.500",
    end = "1:12.500",
    note = "Fictional editorial context",
  },
) {
  await dialog
    .getByLabel("Source URL or private Drive link", { exact: true })
    .fill(url);
  await dialog.getByLabel(/^Source type/).selectOption(kind);
  await dialog.getByLabel(/^Start time/).fill(start);
  await dialog.getByLabel(/^End time/).fill(end);
  await dialog.getByLabel(/^Why it matters/).fill(note);
}
async function saveIntake(dialog) {
  await dialog
    .getByRole("button", { name: "Save intake", exact: true })
    .click();
}
// No synthetic URL may turn into a live provider lookup. API/media handlers
// registered below take precedence, and local frontend assets pass through.
await page.route(/^https?:\/\//, async (route) => {
  if (new URL(route.request().url()).origin !== fixtureOrigin)
    await route.abort("blockedbyclient");
  else await route.continue();
});
// Abort forbidden Google traffic so a regression cannot contact a live account.
await page.route(
  /^https?:\/\/(?:[^/]+\.)?(?:googleapis\.com|google\.com|googleusercontent\.com)(?:\/|$)/,
  async (route) => {
    await route.abort("blockedbyclient");
  },
);
const saves = [];
const media = [];
let fail = false;
let importFailure = false;
const imports = [];
await page.route("**/api/**", async (route) => {
  const req = route.request(),
    path = new URL(req.url()).pathname;
  requests.push({ path, method: req.method() });
  if (intakeFixtureEnabled && (await handleIntakeFixture(route, path))) return;
  let body;
  if (path === "/api/session")
    body = {
      csrfToken: "fixture",
      mode: "production",
      owner: "Test owner",
      integrations: { drive: true, producer: true, intakeProducer: false },
    };
  else if (path === "/api/catalog/status") {
    statusRequests.push({ method: req.method(), body: req.postData() });
    const snapshot = globalThis.structuredClone(catalogStatus);
    if (holdStatusResponses)
      await new Promise((resolve) => heldStatusResponses.push(resolve));
    if (statusFailure) {
      await route.fulfill({
        status: 503,
        json: { error: { message: "Fixture status service unavailable" } },
      });
      return;
    }
    body = snapshot;
  } else if (path === "/api/import") {
    imports.push({
      method: req.method(),
      body: req.postDataJSON(),
      csrf: req.headers()["x-csrf-token"],
    });
    await new Promise((r) => setTimeout(r, 450));
    if (importFailure) {
      await route.fulfill({
        status: 422,
        json: { error: { message: "Fixture checksum mismatch" } },
      });
      return;
    }
    body = { imported: 1 };
  } else if (path === "/api/intake" && req.method() === "GET")
    body = { version: 0, items: [] };
  else if (path === "/api/episodes") body = [episode];
  else if (path === "/api/episodes/ep-demo") {
    body = globalThis.structuredClone(episode);
    episodeRequests.push({ version: body.catalogVersion });
    if (holdEpisodeResponses)
      await new Promise((resolve) => heldEpisodeResponses.push(resolve));
  } else if (path.endsWith("/reviews")) {
    const input = req.postDataJSON();
    saves.push({ path, input });
    await new Promise((r) => setTimeout(r, 150));
    if (fail) {
      await route.fulfill({
        status: 503,
        json: { error: { message: "Fixture service failure" } },
      });
      return;
    }
    const clip = episode.clips.find((c) => path.includes(c.render.id));
    body = {
      ...input,
      revision: input.expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    clip.render.review = body;
  } else {
    await route.fulfill({
      status: 404,
      json: { error: { message: "Fixture not found" } },
    });
    return;
  }
  await fulfillApiFixture(route, { json: body });
});
let mediaFailureStatus = 0;
let thumbnailFailure = false;
await page.route("**/media/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  media.push(path);
  if (path.endsWith("/thumbnail")) {
    await route.fulfill(
      thumbnailFailure
        ? { status: 404, body: "Thumbnail unavailable" }
        : { status: 200, contentType: "image/png", body: syntheticThumbnail },
    );
    return;
  }
  if (mediaFailureStatus) {
    await route.fulfill({
      status: mediaFailureStatus,
      body: "Synthetic access failure",
    });
    return;
  }
  const size = syntheticVideo.length;
  const value = route.request().headers().range;
  const headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (value) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    const start = match
      ? match[1]
        ? Number(match[1])
        : Math.max(0, size - Number(match[2]))
      : size;
    const end =
      match?.[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!match || start >= size || end < start) {
      await route.fulfill({
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
        body: "",
      });
      return;
    }
    await route.fulfill({
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
      body: syntheticVideo.subarray(start, end + 1),
    });
  } else
    await route.fulfill({
      status: 200,
      headers: { ...headers, "Content-Length": String(size) },
      body: syntheticVideo,
    });
});
try {
  await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:5173/");
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .waitFor();
  await runPublicationBrowserRegression({ page, check });
  check("Import does not run automatically", imports.length === 0);
  check(
    "Populated slate starts with import panel collapsed",
    (await page.locator(".import-control").count()) === 0,
  );
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".clip-thumbnail")).length === 2 &&
      Array.from(document.querySelectorAll(".clip-thumbnail")).every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
  );
  check("Private slate thumbnails decode", true);
  check(
    "Slate requests no video bytes",
    media.every((path) => path.endsWith("/thumbnail")),
  );
  await openTroubleshooting();
  await page
    .getByRole("button", { name: "Import more clips", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import approved clips", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  check(
    "Import prevents duplicate clicks",
    await page
      .getByRole("button", { name: "Importing approved clips…", exact: true })
      .isDisabled(),
  );
  await page.getByText(/Catalog check complete\./).waitFor();
  check(
    "Import uses owner CSRF and no client-selected file IDs",
    imports.length === 1 &&
      imports[0].method === "POST" &&
      imports[0].csrf === "fixture" &&
      Object.keys(imports[0].body).length === 0,
  );
  await page
    .locator(".import-control")
    .getByRole("button", { name: "Refresh slate", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import more clips", exact: true })
    .waitFor();
  check(
    "Successful import and refresh removes setup box",
    (await page.locator(".import-control").count()) === 0,
  );
  await page.reload();
  await page.locator("details.sync-troubleshooting").waitFor();
  await openTroubleshooting();
  await page
    .getByRole("button", { name: "Import more clips", exact: true })
    .waitFor();
  check(
    "Import panel stays collapsed after reload",
    (await page.locator(".import-control").count()) === 0,
  );
  await openTroubleshooting();
  await page
    .getByRole("button", { name: "Import more clips", exact: true })
    .click();
  importFailure = true;
  await page
    .getByRole("button", { name: "Import approved clips", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Fixture checksum mismatch" })
    .waitFor();
  check(
    "Import displays validation failure and permits deliberate retry",
    await page
      .getByRole("button", { name: "Import approved clips", exact: true })
      .isEnabled(),
  );
  importFailure = false;
  await refreshSlate();
  await page
    .getByRole("alert")
    .filter({ hasText: "Fixture checksum mismatch" })
    .waitFor();
  check(
    "Import errors stay available after slate refresh",
    await page.locator(".import-control").isVisible(),
  );
  await page
    .getByRole("button", { name: "Close import controls", exact: true })
    .click();
  thumbnailFailure = true;
  await page.reload();
  await page.locator(".thumb-placeholder").first().waitFor();
  check(
    "Missing thumbnail has a clean fallback",
    (await page.locator(".thumb-placeholder").count()) === 2 &&
      (await page.locator(".clip-thumbnail").count()) === 0,
  );
  thumbnailFailure = false;
  await page.reload();
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".clip-thumbnail")).length === 2 &&
      Array.from(document.querySelectorAll(".clip-thumbnail")).every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
  );
  for (const width of [1144, 390]) {
    await page.setViewportSize({ width, height: 900 });
    check(
      `Long slate copy stays inside identity column at ${width}px`,
      await page
        .locator(".clip-identity")
        .first()
        .evaluate((identity) => {
          const title = identity.querySelector("strong");
          title.textContent =
            "Alex Example, author of Markets Today; interviewer question about international monetary policy";
          const label = title.getBoundingClientRect(),
            bounds = identity.getBoundingClientRect();
          return (
            label.right <= bounds.right + 1 &&
            title.scrollWidth > title.clientWidth &&
            getComputedStyle(title).overflow === "hidden"
          );
        }),
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture("desktop-slate");
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .click();
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 2 && !v.error;
  });
  check(
    "Import controls stay out of the active review",
    (await page.locator(".import-control").count()) === 0 ||
      (await page.locator(".import-control").isHidden()),
  );
  await capture("desktop-review");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("mobile-review");
  await page
    .getByRole("button", { name: "Episode 1", exact: false })
    .first()
    .click();
  await capture("mobile-slate");
  const readyRow = page.getByRole("button", {
    name: "Review Clip c1 by Speaker c1",
  });
  const blockedRow = page.getByRole("button", {
    name: "Review Clip c2 by Speaker c2",
  });
  check(
    "Mobile ready production label visible",
    await readyRow.getByText("Ready for review", { exact: true }).isVisible(),
  );
  check(
    "Mobile blocked production label visible",
    await blockedRow.getByText("Blocked", { exact: true }).isVisible(),
  );
  check(
    "Mobile QA detail visible",
    await readyRow.getByText(/See QA evidence/).isVisible(),
  );
  check(
    "Mobile pending QA visible",
    await blockedRow
      .getByText("Playback check pending", { exact: true })
      .isVisible(),
  );
  check(
    "Mobile last real progress visible",
    await blockedRow.getByText(/Last progress:/).isVisible(),
  );
  episode.clips[1].production = {
    ...episode.clips[1].production,
    state: "working",
    blocker: null,
  };
  await refreshSlate();
  await blockedRow
    .getByText("Stale · status unknown", { exact: true })
    .waitFor();
  check(
    "Mobile stale status visible",
    await blockedRow
      .getByText("Stale · status unknown", { exact: true })
      .isVisible(),
  );
  await capture("mobile-stale-slate");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .click();
  check(
    "Original-only video route",
    media.includes("/media/c1-v1/original") &&
      !media.some((p) => p.endsWith("/proxy")),
    media.join(","),
  );
  await runWorkflowBrowserRegression({
    page,
    check,
    renderId: "c1-v1",
    episodeId: "ep-demo",
  });
  await page
    .locator("details[open].workflow-panel > summary")
    .evaluateAll((nodes) => nodes.forEach((node) => node.click()));
  await page.locator("#review-note").fill("Keep this draft");
  await page.reload();
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .click();
  check(
    "Draft survives full page reload",
    (await page.locator("#review-note").inputValue()) === "Keep this draft",
  );
  await page.getByRole("button", { name: "Next clip", exact: true }).click();
  await page
    .getByRole("button", { name: "Previous clip", exact: true })
    .click();
  check(
    "Draft survives next/previous",
    (await page.locator("#review-note").inputValue()) === "Keep this draft",
  );
  await page
    .getByRole("button", { name: "Episode 1", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .click();
  check(
    "Draft survives back/reopen",
    (await page.locator("#review-note").inputValue()) === "Keep this draft",
  );
  await page
    .getByRole("button", { name: "Episode 1", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "Keyboard & help" }).click();
  await page.getByRole("checkbox").check();
  await page.keyboard.press("Escape");
  check(
    "Escape dismisses help",
    (await page.getByRole("dialog").count()) === 0,
  );
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .click();
  await page.locator("#review-note").focus();
  await page.keyboard.press("Alt+a");
  check("Approval shortcut never steals note input", saves.length === 0);
  await page.goBack();
  await page.goForward();
  await page.locator("#review-note").waitFor();
  check(
    "Browser Back/Forward retains draft",
    (await page.locator("#review-note").inputValue()) === "Keep this draft",
  );
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 2 && !v.error;
  });
  check(
    "Synthetic H.264/AAC loaded native metadata",
    await page
      .locator("video")
      .evaluate(
        (v) => v.duration > 29 && v.duration < 31 && v.videoWidth === 320,
      ),
  );
  await page.getByRole("button", { name: /Second passage/ }).click();
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && !v.seeking && Math.abs(v.currentTime - 20) < 0.25;
  });
  check(
    "Native render-relative transcript seek",
    await page
      .locator("video")
      .evaluate((v) => Math.abs(v.currentTime - 20) < 0.25),
  );
  await page.locator("video").evaluate(async (v) => {
    v.muted = true;
    await v.play();
  });
  await page.waitForFunction(
    () => document.querySelector("video")?.currentTime > 20.25,
  );
  await page.locator("video").evaluate((v) => v.pause());
  check("Synthetic native video playback advances", true);
  await page.getByRole("button", { name: /^Approve/ }).evaluate((b) => {
    b.click();
    b.click();
  });
  await page.waitForTimeout(400);
  check(
    "Repeated synchronous approve creates one save",
    saves.length === 1,
    `saves=${saves.length}`,
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(350);
  check(
    "Undo writes to exact reviewed render",
    saves.length === 2 &&
      saves[1].path === "/api/renders/c1-v1/reviews" &&
      saves[1].input.decision === "clear",
  );
  fail = true;
  await page.locator("#review-note").fill("Preserve after failure");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Save could not be confirmed" })
    .waitFor();
  check(
    "Failed save preserves draft",
    (await page.locator("#review-note").inputValue()) ===
      "Preserve after failure",
  );
  episode.clips[0].render = {
    ...episode.clips[0].render,
    id: "c1-v2",
    version: 2,
    review: {
      decision: "clear",
      revision: 0,
      note: "",
      reason: "",
      updatedAt: null,
    },
  };
  episode.clips[0].currentRenderId = "c1-v2";
  episode.clips[0].renderIds.push("c1-v2");
  await page
    .getByRole("button", { name: "Back to slate to refresh", exact: true })
    .click();
  await refreshSlate();
  await page.waitForTimeout(250);
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .click();
  check(
    "Replacement render does not inherit old draft",
    (await page.locator("#review-note").inputValue()) === "",
  );
  await page
    .getByRole("button", { name: "Episode 1", exact: false })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Search clips, speakers or sources" })
    .fill("nonexistent unique text");
  await page
    .getByRole("heading", { name: "No clips match this view" })
    .waitFor();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  check(
    "Filtered empty view can recover",
    (await page.getByRole("button", { name: /^Review Clip/ }).count()) === 2,
  );
  for (const status of [403, 404]) {
    mediaFailureStatus = status;
    await page
      .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
      .click();
    await page.locator("#review-note").fill(`Keep draft during ${status}`);
    await page
      .getByRole("alert")
      .filter({ hasText: "Playback unavailable" })
      .waitFor();
    check(
      `Media ${status} has explicit failure without native spinner`,
      !(await page.locator("video").isVisible()),
    );
    check(
      `Media ${status} preserves draft`,
      (await page.locator("#review-note").inputValue()) ===
        `Keep draft during ${status}`,
    );
    check(
      `Media ${status} disables transcript seeking`,
      await page.getByRole("button", { name: /Second passage/ }).isDisabled(),
    );
    await capture(`desktop-media-${status}`);
    mediaFailureStatus = 0;
    await page.getByRole("button", { name: /Retry playback/ }).click();
    await page.waitForFunction(() => {
      const v = document.querySelector("video");
      return v && v.readyState >= 2 && !v.error;
    });
    check(
      `Media ${status} retry restores synthetic native playback`,
      (await page.locator("#review-note").inputValue()) ===
        `Keep draft during ${status}`,
    );
    await page
      .getByRole("button", { name: "Episode 1", exact: false })
      .first()
      .click();
  }
  // Automatic sync is status-only. Catalog reads stay explicit, and every
  // response below is synthetic so this suite never reaches a Google account.
  Object.assign(episode, globalThis.structuredClone(initialEpisode));
  updateCatalogStatus(1);
  fail = false;
  const automaticRequestStart = requests.length;
  const automaticImportStart = imports.length;
  await page.clock.install({ time: new Date("2026-10-08T03:00:00Z") });
  await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:5173/");
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .waitFor();
  await page
    .locator(".catalog-sync")
    .getByText("Automatic catalog sync", { exact: true })
    .waitFor();
  await page
    .locator(".catalog-sync")
    .getByText(/Last successful sync:/)
    .waitFor();
  check(
    "Automatic sync leaves manual import behind closed troubleshooting",
    !(await page
      .locator("details.sync-troubleshooting")
      .evaluate((d) => d.open)) &&
      !(await page
        .getByRole("button", { name: "Import approved clips", exact: true })
        .isVisible()),
  );
  const initialStatusCount = statusRequests.length;
  const initialSnapshotCount = episodeRequests.length;
  await page.clock.fastForward(31000);
  await waitUntil(
    () => statusRequests.length > initialStatusCount,
    "scheduled visible-page status poll",
  );
  check(
    "Visible-page timer reads only lightweight catalog status",
    episodeRequests.length === initialSnapshotCount &&
      imports.length === automaticImportStart &&
      statusRequests.every(
        (request) => request.method === "GET" && request.body === null,
      ),
  );
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .click();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video && video.readyState >= 2 && !video.error;
  });
  await page
    .locator("#review-note")
    .fill("Keep this automatic-sync review draft");
  // The wrapping Reason label also contains option text. Scope the actual
  // native select by its form row instead of exact-matching that label's text.
  const reviewReason = page.locator(".reason-row").getByRole("combobox");
  await reviewReason.selectOption("Needs context");
  await page.locator("video").evaluate((video) => {
    video.dataset.catalogProbe = "original-review";
    video.currentTime = 6;
  });
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video && !video.seeking && Math.abs(video.currentTime - 6) < 0.25;
  });
  await page.locator("video").evaluate(async (video) => {
    video.muted = true;
    await video.play();
  });
  await page.locator("#review-note").focus();
  const timeBeforeCatalogUpdate = await page
    .locator("video")
    .evaluate((video) => video.currentTime);
  const reviewSnapshotCount = episodeRequests.length;
  episode.clips[0] = {
    ...episode.clips[0],
    catalogRevision: 2,
    currentRenderId: "c1-sync-v2",
    renderIds: ["c1-v1", "c1-sync-v2"],
    render: {
      ...episode.clips[0].render,
      id: "c1-sync-v2",
      version: 2,
    },
  };
  episode.clips.push(makeClip("c3"));
  episode.clipCount = 3;
  updateCatalogStatus(2);
  await pollCatalog();
  const updateBanner = page.locator(".catalog-update-banner");
  await updateBanner
    .getByText("1 new clip and 1 changed clip available", { exact: true })
    .waitFor();
  check(
    "Status poll reports distinct new and changed clips without fetching the slate",
    episodeRequests.length === reviewSnapshotCount &&
      (await updateBanner.getByRole("status").getAttribute("aria-live")) ===
        "polite" &&
      (await updateBanner.getByRole("status").getAttribute("aria-atomic")) ===
        "true",
  );
  check(
    "Catalog update preserves native video element, source, time and playback",
    await page
      .locator("video")
      .evaluate(
        (video, previousTime) =>
          video.dataset.catalogProbe === "original-review" &&
          video.currentSrc.endsWith("/media/c1-v1/original") &&
          video.currentTime >= previousTime &&
          !video.paused &&
          !video.error,
        timeBeforeCatalogUpdate,
      ),
  );
  check(
    "Catalog update preserves unsaved note, reason and typing focus",
    (await page.locator("#review-note").inputValue()) ===
      "Keep this automatic-sync review draft" &&
      (await reviewReason.inputValue()) === "Needs context" &&
      (await page
        .locator("#review-note")
        .evaluate((note) => note === document.activeElement)),
  );
  check(
    "Active review offers return to slate instead of applying updates",
    (await updateBanner
      .getByRole("button", { name: "Return to slate", exact: true })
      .isVisible()) &&
      (await updateBanner
        .getByRole("button", { name: "Apply updates", exact: true })
        .count()) === 0,
  );
  await pollCatalog();
  check(
    "Repeated status responses do not inflate change counts",
    (await updateBanner
      .getByText("1 new clip and 1 changed clip available", { exact: true })
      .count()) === 1 && episodeRequests.length === reviewSnapshotCount,
  );
  await page.locator("video").evaluate((video) => video.pause());
  const pausedTime = await page
    .locator("video")
    .evaluate((video) => video.currentTime);
  catalogStatus.sync.lastError = "Fixture catalog quota failure";
  await pollCatalog();
  await page
    .locator(".catalog-sync")
    .getByText(/Fixture catalog quota failure/)
    .waitFor();
  check(
    "Catalog failure keeps last successful sync and pending updates visible",
    (await page
      .locator(".catalog-sync")
      .getByText(/Last successful sync:/)
      .isVisible()) &&
      (await page.locator(".catalog-sync time").getAttribute("datetime")) ===
        "2026-10-08T02:55:00Z" &&
      (await updateBanner.isVisible()) &&
      (await page
        .locator("video")
        .evaluate(
          (video, expectedTime) =>
            video.dataset.catalogProbe === "original-review" &&
            Math.abs(video.currentTime - expectedTime) < 0.1,
          pausedTime,
        )),
  );
  statusFailure = true;
  await pollCatalog();
  await page
    .locator(".catalog-sync")
    .getByText(/Fixture status service unavailable/)
    .waitFor();
  check(
    "Status endpoint failure retains loaded clips, last success and review draft",
    (await page
      .locator(".catalog-sync")
      .getByText(/Last successful sync:/)
      .isVisible()) &&
      (await page.locator(".catalog-sync time").getAttribute("datetime")) ===
        "2026-10-08T02:55:00Z" &&
      (await updateBanner.isVisible()) &&
      (await page.locator("#review-note").inputValue()) ===
        "Keep this automatic-sync review draft",
  );
  statusFailure = false;
  catalogStatus.sync.lastError = null;
  await pollCatalog();
  await setPageVisibility(false);
  const hiddenRequestCount = statusRequests.length;
  await page.clock.fastForward(120000);
  await page.waitForTimeout(100);
  check(
    "Hidden page makes no status polls",
    statusRequests.length === hiddenRequestCount,
  );
  await setPageVisibility(true);
  await waitUntil(
    () => statusRequests.length > hiddenRequestCount,
    "status resumes when visible",
  );
  check("Returning to visible page checks status immediately", true);
  await page.waitForTimeout(100);
  holdStatusResponses = true;
  const beforeHeldStatus = statusRequests.length;
  await pollCatalog();
  await waitUntil(
    () => heldStatusResponses.length === 1,
    "held status response",
  );
  await page.evaluate(() => {
    document.dispatchEvent(new document.defaultView.Event("visibilitychange"));
    document.dispatchEvent(new document.defaultView.Event("visibilitychange"));
  });
  await page.waitForTimeout(100);
  check(
    "Repeated visible notifications cannot overlap an in-flight status read",
    statusRequests.length === beforeHeldStatus + 1 &&
      heldStatusResponses.length === 1,
  );
  holdStatusResponses = false;
  await releaseResponses(heldStatusResponses);
  await updateBanner
    .getByRole("button", { name: "Return to slate", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .waitFor();
  check(
    "Returning to slate keeps its existing snapshot until explicit apply",
    (await page.getByRole("button", { name: /^Review Clip/ }).count()) === 2 &&
      (await updateBanner
        .getByRole("button", { name: "Apply updates", exact: true })
        .isEnabled()),
  );
  holdEpisodeResponses = true;
  const beforeCancelledApply = episodeRequests.length;
  await updateBanner
    .getByRole("button", { name: "Apply updates", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await waitUntil(
    () => heldEpisodeResponses.length === 1,
    "held apply response",
  );
  check(
    "Repeated apply clicks issue one snapshot read while old slate stays usable",
    episodeRequests.length === beforeCancelledApply + 1 &&
      (await page.getByRole("button", { name: /^Review Clip/ }).count()) === 2,
  );
  await page
    .getByRole("button", { name: "Cancel refresh", exact: true })
    .click();
  holdEpisodeResponses = false;
  await releaseResponses(heldEpisodeResponses);
  check(
    "Cancel ignores late apply response and retains the pending notice",
    (await page.getByRole("button", { name: /^Review Clip/ }).count()) === 2 &&
      (await updateBanner
        .getByText("1 new clip and 1 changed clip available", { exact: true })
        .isVisible()) &&
      (await updateBanner
        .getByRole("button", { name: "Apply updates", exact: true })
        .isEnabled()),
  );
  holdEpisodeResponses = true;
  await updateBanner
    .getByRole("button", { name: "Apply updates", exact: true })
    .click();
  await waitUntil(
    () => heldEpisodeResponses.length === 1,
    "held navigation race response",
  );
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .click();
  await page.locator("#review-note").waitFor();
  holdEpisodeResponses = false;
  await releaseResponses(heldEpisodeResponses);
  check(
    "Opening a clip cancels stale apply without replacing its render or draft",
    (await page.locator("#review-note").inputValue()) ===
      "Keep this automatic-sync review draft" &&
      (await page.locator("video").getAttribute("src")) ===
        "/media/c1-v1/original" &&
      new URL(page.url()).hash === "#clip/c1",
  );
  // Establish real history entries: c1 -> c2 -> slate, then Back during apply.
  await page.getByRole("button", { name: "Next clip", exact: true }).click();
  await page
    .getByRole("button", { name: "Episode 1", exact: false })
    .first()
    .click();
  holdEpisodeResponses = true;
  await updateBanner
    .getByRole("button", { name: "Apply updates", exact: true })
    .click();
  await waitUntil(
    () => heldEpisodeResponses.length === 1,
    "held browser-back response",
  );
  await page.goBack();
  await page.locator("#review-note").waitFor();
  holdEpisodeResponses = false;
  await releaseResponses(heldEpisodeResponses);
  check(
    "Browser Back cancels late apply and restores the exact review draft",
    new URL(page.url()).hash === "#clip/c1" &&
      (await page.locator("#review-note").inputValue()) ===
        "Keep this automatic-sync review draft" &&
      (await page.locator("video").getAttribute("src")) ===
        "/media/c1-v1/original",
  );
  await page.goForward();
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .waitFor();
  check(
    "Browser Forward after canceled apply restores unchanged slate",
    new URL(page.url()).hash === "" &&
      (await page.getByRole("button", { name: /^Review Clip/ }).count()) === 2,
  );
  // A newer sync lands while an older snapshot is loading. Applying version 2
  // must not accidentally dismiss the version 3 notice or count its new clip twice.
  holdEpisodeResponses = true;
  await updateBanner
    .getByRole("button", { name: "Apply updates", exact: true })
    .click();
  await waitUntil(
    () => heldEpisodeResponses.length === 1,
    "version 2 snapshot response",
  );
  episode.clips.push(makeClip("c4"));
  episode.clipCount = 4;
  updateCatalogStatus(3);
  await pollCatalog();
  await updateBanner
    .getByText("2 new clips and 1 changed clip available", { exact: true })
    .waitFor();
  holdEpisodeResponses = false;
  await releaseResponses(heldEpisodeResponses);
  await page
    .getByRole("button", { name: "Review Clip c3 by Speaker c3" })
    .waitFor();
  await updateBanner
    .getByText("1 new clip available", { exact: true })
    .waitFor();
  check(
    "Applying an older snapshot keeps the newer outstanding update notice",
    (await page.getByRole("button", { name: /^Review Clip/ }).count()) === 3 &&
      (await page
        .getByRole("button", { name: "Review Clip c4 by Speaker c4" })
        .count()) === 0,
  );
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .click();
  check(
    "Deliberately applied replacement render never inherits the previous render draft",
    (await page.locator("#review-note").inputValue()) === "" &&
      (await page.locator("video").getAttribute("src")) ===
        "/media/c1-sync-v2/original",
  );
  await updateBanner
    .getByRole("button", { name: "Return to slate", exact: true })
    .click();
  await updateBanner
    .getByRole("button", { name: "Apply updates", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review Clip c4 by Speaker c4" })
    .waitFor();
  await updateBanner.waitFor({ state: "hidden" });
  check(
    "Explicit apply acknowledges the latest snapshot and clears the banner",
    (await page.getByRole("button", { name: /^Review Clip/ }).count()) === 4,
  );
  catalogStatus.version = 4;
  catalogStatus.clips.push({
    id: "other-episode-clip",
    episodeId: "ep-other",
    revision: 4,
    currentRenderId: "other-episode-v1",
  });
  await pollCatalog();
  check(
    "Unattributed global change uses a generic notice instead of invented clip counts",
    await updateBanner
      .getByText("Catalog updates available", { exact: true })
      .isVisible(),
  );
  check(
    "Automatic catalog checks never POST imports or contact Google from the page",
    imports.length === automaticImportStart &&
      requests
        .slice(automaticRequestStart)
        .every((request) => request.method === "GET") &&
      googleRequests.length === 0,
  );
  // A user save wins over a stale in-flight snapshot, even from the slate.
  await page
    .getByRole("button", { name: "Review Clip c2 by Speaker c2" })
    .click();
  await page.getByRole("button", { name: /^Approve/ }).click();
  await page.getByText("Decision saved · Approved", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Episode 1", exact: false })
    .first()
    .click();
  episode.clips.find((clip) => clip.id === "c4").catalogRevision = 5;
  updateCatalogStatus(5);
  await pollCatalog();
  await updateBanner
    .getByText("1 changed clip available", { exact: true })
    .waitFor();
  holdEpisodeResponses = true;
  await updateBanner
    .getByRole("button", { name: "Apply updates", exact: true })
    .click();
  await waitUntil(
    () => heldEpisodeResponses.length === 1,
    "snapshot before Undo race",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  check(
    "Starting Undo cancels refresh and disables apply until the save finishes",
    (await updateBanner
      .getByRole("button", { name: "Apply updates", exact: true })
      .isDisabled()) &&
      (await page
        .getByRole("button", { name: "Cancel refresh", exact: true })
        .count()) === 0,
  );
  await page
    .getByText("Decision saved · Not reviewed", { exact: true })
    .waitFor();
  holdEpisodeResponses = false;
  await releaseResponses(heldEpisodeResponses);
  check(
    "Late apply response cannot undo a newer acknowledged review save",
    (await page
      .getByRole("button", { name: "Review Clip c2 by Speaker c2" })
      .getByText("Not reviewed", { exact: true })
      .isVisible()) &&
      (await updateBanner
        .getByText("1 changed clip available", { exact: true })
        .isVisible()) &&
      saves.at(-1).path === "/api/renders/c2-v1/reviews" &&
      saves.at(-1).input.decision === "clear" &&
      saves.at(-1).input.expectedRevision === 1,
  );
  await capture("automatic-sync-slate");

  // Empty episode workspaces and manual intake are separate from rendered
  // clips. Every source below is fabricated; external traffic is blocked.
  intakeFixtureEnabled = true;
  await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:5173/");
  const episodePicker = page.getByRole("combobox", {
    name: "Episode",
    exact: true,
  });
  await page
    .getByRole("heading", { name: "No reviewable clips yet", exact: true })
    .waitFor();
  check(
    "Active empty episode 127 opens without falling back to episode 126",
    (await episodePicker.inputValue()) === "ep-127" &&
      new URL(page.url()).searchParams.get("episode") === "ep-127" &&
      (await page.getByRole("button", { name: /^Review Clip/ }).count()) ===
        0 &&
      (await episodePicker.locator("option").allTextContents()).some((text) =>
        /Episode 126.*published/.test(text),
      ),
  );
  await capture("episode-127-empty");
  await chooseWorkspace("ep-126");
  const previousClip = page.getByRole("button", {
    name: "Review Clip c126a by Speaker c126a",
    exact: true,
  });
  await previousClip.waitFor();
  check(
    "Episode picker loads the selected published slate",
    (await page.locator(".clip-row").count()) === 2,
  );
  await page.reload();
  await previousClip.waitFor();
  check(
    "Episode selection survives a full refresh",
    (await episodePicker.inputValue()) === "ep-126",
  );
  await chooseWorkspace("ep-127");
  await page
    .getByRole("heading", { name: "No reviewable clips yet", exact: true })
    .waitFor();
  await page.goBack();
  await previousClip.waitFor();
  check(
    "Browser Back restores the prior episode slate",
    (await episodePicker.inputValue()) === "ep-126",
  );
  await page.goForward();
  await page
    .getByRole("heading", { name: "No reviewable clips yet", exact: true })
    .waitFor();
  check(
    "Browser Forward restores the empty active workspace",
    (await episodePicker.inputValue()) === "ep-127",
  );

  heldWorkspaceId = "ep-126";
  await chooseWorkspace("ep-126");
  await waitUntil(
    () => heldWorkspaceResponses.length === 1,
    "held old episode load",
  );
  check(
    "Switching episodes clears the prior slate while the requested workspace loads",
    (await page.locator(".clip-row").count()) === 0,
  );
  await page.goBack();
  await page
    .getByRole("heading", { name: "No reviewable clips yet", exact: true })
    .waitFor();
  heldWorkspaceId = null;
  await releaseResponses(heldWorkspaceResponses);
  check(
    "Late episode response cannot replace a newer browser navigation",
    (await episodePicker.inputValue()) === "ep-127" &&
      new URL(page.url()).searchParams.get("episode") === "ep-127" &&
      (await page.locator(".clip-row").count()) === 0,
  );
  await chooseWorkspace("ep-126");
  await previousClip.waitFor();
  await previousClip.click();
  await page
    .locator("#review-note")
    .fill("Keep this exact episode-126 render draft");
  await page
    .getByRole("button", { name: "Episode 126", exact: false })
    .first()
    .click();
  await chooseWorkspace("ep-127");
  await page
    .getByRole("heading", { name: "No reviewable clips yet", exact: true })
    .waitFor();
  await chooseWorkspace("ep-126");
  await previousClip.waitFor();
  await previousClip.click();
  check(
    "Review draft stays attached to its exact render across episode switches",
    (await page.locator("#review-note").inputValue()) ===
      "Keep this exact episode-126 render draft" &&
      (await page.locator("video").getAttribute("src")) ===
        "/media/c126a-v1/original",
  );
  await page
    .getByRole("button", { name: "Episode 126", exact: false })
    .first()
    .click();
  heldWorkspaceId = "ep-126";
  await refreshSlate();
  await waitUntil(
    () => heldWorkspaceResponses.length === 1,
    "held refresh before episode switch",
  );
  await chooseWorkspace("ep-127");
  await page
    .getByRole("heading", { name: "No reviewable clips yet", exact: true })
    .waitFor();
  heldWorkspaceId = null;
  await releaseResponses(heldWorkspaceResponses);
  check(
    "Late refresh cannot relabel an old slate as the new episode",
    (await episodePicker.inputValue()) === "ep-127" &&
      (await page.locator(".clip-row").count()) === 0,
  );

  let intakeDialog = await openIntake();
  const uploadFolder = intakeDialog.getByRole("link", {
    name: /Open private episode upload folder/,
  });
  await uploadFolder.waitFor();
  check(
    "Configured private upload folder is an isolated external link, not an upload widget",
    (await uploadFolder.getAttribute("href")) ===
      "https://drive.google.com/drive/folders/fictional-intake-folder" &&
      (await uploadFolder.getAttribute("target")) === "_blank" &&
      /\bnoopener\b/.test(await uploadFolder.getAttribute("rel")) &&
      /\bnoreferrer\b/.test(await uploadFolder.getAttribute("rel")) &&
      (await page.locator('input[type="file"],iframe').count()) === 0 &&
      (await intakeDialog
        .getByText(/The dashboard does not upload files/)
        .isVisible()),
  );
  const validationWriteCount = intakeWrites.length;
  for (const url of [
    "javascript:alert(1)",
    "https://user:password@example.com/source",
    "http://127.0.0.1/source",
    "https://drive.google.com/drive/folders/fictional-folder",
  ]) {
    await fillIntake(intakeDialog, { url });
    await saveIntake(intakeDialog);
    await intakeDialog.getByRole("alert").waitFor();
    check(
      `Unsafe or non-file source is rejected before save: ${url.split(":")[0]} ${new URL(url).hostname || "script"}`,
      intakeWrites.length === validationWriteCount &&
        (await intakeDialog
          .getByRole("button", { name: "Save intake", exact: true })
          .isEnabled()),
    );
  }
  for (const [start, end] of [
    ["1:20", "1:10"],
    ["1:99", "2:00"],
    ["1:00", ""],
    ["-1", "2"],
  ]) {
    await fillIntake(intakeDialog, {
      url: "https://youtu.be/FixtureAb12",
      start,
      end,
    });
    await saveIntake(intakeDialog);
    await intakeDialog.getByRole("alert").waitFor();
    check(
      `Invalid source range ${start}–${end || "missing"} never creates intake`,
      intakeWrites.length === validationWriteCount,
    );
  }
  await fillIntake(intakeDialog, {
    url: "https://youtu.be/FixtureAb12",
    note: "Fictional first source",
  });
  await intakeDialog
    .getByRole("button", { name: "Close intake", exact: true })
    .click();
  intakeDialog = await openIntake();
  check(
    "Closing and reopening intake preserves the unsaved source draft",
    (await intakeDialog.getByLabel(/^Why it matters/).inputValue()) ===
      "Fictional first source" && intakeWrites.length === validationWriteCount,
  );
  await page.reload();
  intakeDialog = await openIntake();
  check(
    "Unsaved manual intake draft survives page refresh with its episode assignment",
    (await intakeDialog
      .getByLabel("Source URL or private Drive link", { exact: true })
      .inputValue()) === "https://youtu.be/FixtureAb12" &&
      (await intakeDialog.getByLabel(/^Episode assignment/).inputValue()) ===
        "ep-127" &&
      (await intakeDialog.getByLabel(/^Why it matters/).inputValue()) ===
        "Fictional first source" &&
      intakeWrites.length === validationWriteCount,
  );
  // Establish history entries in the current document after reload. Otherwise
  // Back could leave the document entirely instead of testing its popstate guard.
  await intakeDialog
    .getByRole("button", { name: "Close intake", exact: true })
    .click();
  await chooseWorkspace("ep-126");
  await previousClip.waitFor();
  await chooseWorkspace("ep-127");
  await page
    .getByRole("heading", { name: "No reviewable clips yet", exact: true })
    .waitFor();
  intakeDialog = await openIntake();
  intakeSaveMode = "hold";
  await intakeDialog
    .getByRole("button", { name: "Save intake", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await waitUntil(
    () => heldIntakeWrites.length === 1,
    "single held intake submission",
  );
  check(
    "Repeated intake clicks create one request and lock the in-flight form",
    intakeWrites.length === validationWriteCount + 1 &&
      (await intakeDialog
        .getByRole("button", { name: "Saving…", exact: true })
        .isDisabled()) &&
      (await intakeDialog
        .getByRole("button", { name: "Close intake", exact: true })
        .isDisabled()) &&
      (await episodePicker.isDisabled()),
  );
  await page.goBack();
  await page.waitForTimeout(100);
  check(
    "Browser Back during intake save retains its exact episode and source request",
    new URL(page.url()).searchParams.get("episode") === "ep-127" &&
      (await episodePicker.inputValue()) === "ep-127" &&
      (await intakeDialog.getByLabel(/^Why it matters/).inputValue()) ===
        "Fictional first source" &&
      intakeWrites.length === validationWriteCount + 1,
  );
  intakeSaveMode = "success";
  await releaseResponses(heldIntakeWrites);
  await page.locator(".intake-card").waitFor();
  const firstWrite = intakeWrites[validationWriteCount];
  check(
    "Manual source saves with CSRF, source-relative milliseconds and an operation key",
    firstWrite.csrf === "fixture" &&
      firstWrite.input.episodeId === "ep-127" &&
      firstWrite.input.kind === "full_source" &&
      firstWrite.input.inMs === 62500 &&
      firstWrite.input.outMs === 72500 &&
      firstWrite.input.expectedRevision === 0 &&
      typeof firstWrite.input.idempotencyKey === "string",
  );
  check(
    "Saved intake is Added by you and awaiting processing, never a playable or ready clip",
    (await page
      .locator(".manual-intake")
      .getByRole("heading", { name: /^Added by you/ })
      .isVisible()) &&
      (await page
        .locator(".intake-card")
        .getByText("Saved · awaiting processing", { exact: true })
        .isVisible()) &&
      (await page
        .locator(".manual-intake")
        .getByText(/No processor is connected yet\. Saved submissions/)
        .isVisible()) &&
      (await page.locator(".clip-row,video").count()) === 0 &&
      !(await page
        .locator(".intake-card")
        .getByText("Ready for review", { exact: true })
        .count()),
  );
  await pollCatalog();
  check(
    "Intake-only version changes do not invent new rendered clips",
    (await page.locator(".catalog-update-banner").count()) === 0 &&
      intakeEpisodes[0].catalogVersion === 1 &&
      (await page.locator(".clip-row").count()) === 0,
  );
  await capture("manual-intake-pending");

  intakeDialog = await openIntake();
  await fillIntake(intakeDialog, {
    url: "https://www.youtube.com/watch?v=FixtureAb12&utm_source=fixture",
  });
  await saveIntake(intakeDialog);
  await intakeDialog
    .getByRole("button", { name: "Open existing", exact: true })
    .waitFor();
  check(
    "Canonical duplicate offers Open existing without creating a second submission",
    manualIntake.length === 1 &&
      (await page.locator(".intake-card").count()) === 1,
  );
  await intakeDialog
    .getByRole("button", { name: "Open existing", exact: true })
    .click();
  const editDialog = page.getByRole("dialog", {
    name: "Edit your submission",
    exact: true,
  });
  await editDialog.waitFor();
  check(
    "Open existing shows the exact saved intake",
    (await editDialog.getByLabel(/^Why it matters/).inputValue()) ===
      "Fictional first source" &&
      (await editDialog
        .getByLabel("Source URL or private Drive link", { exact: true })
        .isDisabled()),
  );
  await editDialog
    .getByRole("button", { name: "Close intake", exact: true })
    .click();
  intakeDialog = await openIntake();
  await fillIntake(intakeDialog, { url: "https://youtu.be/FixtureAb12" });
  await saveIntake(intakeDialog);
  await intakeDialog
    .getByRole("button", { name: "Different cut", exact: true })
    .click();
  check(
    "Different cut requires changed source times for an identical range",
    manualIntake.length === 1 &&
      (await intakeDialog
        .getByRole("alert")
        .getByText(/Change the start and end times/)
        .isVisible()),
  );
  await intakeDialog.getByLabel(/^Start time/).fill("1:13");
  await intakeDialog.getByLabel(/^End time/).fill("1:23");
  await saveIntake(intakeDialog);
  await intakeDialog
    .getByRole("button", { name: "Different cut", exact: true })
    .click();
  await intakeDialog.waitFor({ state: "hidden" });
  check(
    "A deliberately confirmed different cut saves a distinct range",
    manualIntake.length === 2 &&
      intakeWrites.at(-1).input.allowDifferentRange === true &&
      manualIntake[1].inMs === 73000 &&
      manualIntake[1].outMs === 83000,
  );

  intakeDialog = await openIntake();
  await fillIntake(intakeDialog, {
    url: "https://example.com/synthetic-uncertain",
    kind: "already_cut",
    start: "",
    end: "",
    note: "Keep exact uncertain request",
  });
  intakeSaveMode = "uncertain";
  await saveIntake(intakeDialog);
  await intakeDialog
    .getByRole("button", { name: "Retry confirmation", exact: true })
    .waitFor();
  const uncertainWrite = intakeWrites.at(-1);
  check(
    "Unconfirmed save checks its operation receipt and retains a locked editable-payload draft",
    operationReads.includes(uncertainWrite.input.idempotencyKey) &&
      (await intakeDialog.getByLabel(/^Why it matters/).inputValue()) ===
        "Keep exact uncertain request" &&
      (await intakeDialog.getByLabel(/^Why it matters/).isDisabled()) &&
      (await intakeDialog
        .getByRole("button", { name: "Close intake", exact: true })
        .isDisabled()),
  );
  await page.reload();
  intakeDialog = page.getByRole("dialog", {
    name: "Add to your slate",
    exact: true,
  });
  await intakeDialog
    .getByRole("button", { name: "Retry confirmation", exact: true })
    .waitFor();
  intakeSaveMode = "success";
  await intakeDialog
    .getByRole("button", { name: "Retry confirmation", exact: true })
    .click();
  await intakeDialog.waitFor({ state: "hidden" });
  check(
    "Retry after reload reuses the exact request key and payload",
    JSON.stringify(intakeWrites.at(-1).input) ===
      JSON.stringify(uncertainWrite.input) && manualIntake.length === 3,
  );
  intakeDialog = await openIntake();
  await fillIntake(intakeDialog, {
    url: "https://example.com/synthetic-committed",
    start: "",
    end: "",
  });
  const beforeCommitted = intakeWrites.length;
  intakeSaveMode = "committed-uncertain";
  await saveIntake(intakeDialog);
  await intakeDialog.waitFor({ state: "hidden" });
  check(
    "A committed save with a lost response reconciles its receipt without a second submission",
    intakeWrites.length === beforeCommitted + 1 &&
      manualIntake.length === 4 &&
      operationReads.at(-1) === intakeWrites.at(-1).input.idempotencyKey,
  );
  intakeSaveMode = "success";

  holdIntakeReads = true;
  await refreshSlate();
  await waitUntil(
    () => heldIntakeResponses.length === 1,
    "old intake snapshot before newer navigation and save",
  );
  holdIntakeReads = false;
  await chooseWorkspace("ep-126");
  await previousClip.waitFor();
  check(
    "Episode-specific pending submissions do not leak into another slate",
    (await page.locator(".intake-card").count()) === 0,
  );
  intakeDialog = await openIntake();
  await fillIntake(intakeDialog, {
    url: "https://example.com/synthetic-newer-save",
    start: "",
    end: "",
    note: "New save wins over an old snapshot",
  });
  await saveIntake(intakeDialog);
  await intakeDialog.waitFor({ state: "hidden" });
  await releaseResponses(heldIntakeResponses);
  check(
    "Old intake response cannot erase a newer save or switch its episode",
    (await episodePicker.inputValue()) === "ep-126" &&
      (await page
        .locator(".intake-card")
        .getByText("New save wins over an old snapshot", { exact: true })
        .isVisible()) &&
      (await page.locator(".clip-row").count()) === 2,
  );
  intakeDialog = await openIntake();
  await fillIntake(intakeDialog, {
    url: "https://example.com/synthetic-unassigned",
    start: "",
    end: "",
    note: "Fictional unassigned source",
  });
  await intakeDialog.getByLabel(/^Episode assignment/).selectOption("");
  check(
    "Unassigned intake cannot expose an unrelated episode upload folder",
    (await intakeDialog
      .getByRole("link", { name: /Open private episode upload folder/ })
      .count()) === 0,
  );
  await saveIntake(intakeDialog);
  await intakeDialog.waitFor({ state: "hidden" });
  check(
    "Unassigned intake is saved separately from the episode queue",
    intakeWrites.at(-1).input.episodeId === null &&
      (await page.locator(".unassigned-intakes .intake-card").count()) === 1 &&
      (await page.locator(".clip-row").count()) === 2,
  );
  await chooseWorkspace("ep-127");
  await page
    .getByRole("heading", { name: "No reviewable clips yet", exact: true })
    .waitFor();
  intakeEpisodes[0].uploadFolderUrl =
    "https://drive.google.com.evil.example/drive/folders/fictional-folder";
  await refreshSlate();
  await page
    .getByRole("button", { name: "Cancel refresh", exact: true })
    .waitFor({ state: "hidden" });
  intakeDialog = await openIntake();
  check(
    "An untrusted upload-folder host is not rendered as a link",
    (await intakeDialog
      .getByRole("link", { name: /Open private episode upload folder/ })
      .count()) === 0 &&
      (await intakeDialog
        .getByText(/No private upload folder is configured/)
        .isVisible()),
  );
  await intakeDialog
    .getByRole("button", { name: "Close intake", exact: true })
    .click();

  // An exact duplicate must win even when the server lists a different cut
  // first. All duplicate IDs still refer only to synthetic records.
  intakeDialog = await openIntake();
  await fillIntake(intakeDialog, {
    url: "https://example.com/synthetic-duplicate-order",
    start: "",
    end: "",
  });
  nextIntakeDuplicateMatches = [
    {
      kind: "intake",
      id: manualIntake[1].id,
      episodeId: "ep-127",
      rangeMatch: "different",
    },
    {
      kind: "intake",
      id: manualIntake[0].id,
      episodeId: "ep-127",
      rangeMatch: "exact",
    },
  ];
  await saveIntake(intakeDialog);
  await intakeDialog
    .getByRole("button", { name: "Open existing", exact: true })
    .click();
  await editDialog.waitFor();
  check(
    "Open existing prefers an exact duplicate over an earlier different-range match",
    (await editDialog.getByLabel(/^Why it matters/).inputValue()) ===
      "Fictional first source",
  );

  await editDialog
    .getByLabel(/^Why it matters/)
    .fill("Old edit draft retains revision one");
  await editDialog
    .getByRole("button", { name: "Close intake", exact: true })
    .click();
  const editedFixture = manualIntake[0];
  editedFixture.revision += 1;
  editedFixture.whyItMatters = "Newer synthetic server note must win";
  intakeVersion += 1;
  await page.reload();
  await page
    .locator(`#intake-${editedFixture.id}`)
    .getByRole("button", { name: "Edit intake", exact: true })
    .click();
  await editDialog.waitFor();
  check(
    "An edit draft survives reload without adopting a newer server revision",
    (await editDialog.getByLabel(/^Why it matters/).inputValue()) ===
      "Old edit draft retains revision one",
  );
  await editDialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await editDialog
    .getByRole("alert")
    .filter({ hasText: "This submission changed elsewhere." })
    .waitFor();
  check(
    "A stale edit sends its original revision and receives conflict instead of overwriting",
    intakeWrites.at(-1).path === `/api/intake/${editedFixture.id}` &&
      intakeWrites.at(-1).input.expectedRevision === 1 &&
      editedFixture.revision === 2 &&
      editedFixture.whyItMatters === "Newer synthetic server note must win" &&
      (await editDialog
        .getByRole("button", { name: "Save changes", exact: true })
        .isDisabled()),
  );
  await editDialog
    .getByRole("button", { name: "Close intake", exact: true })
    .click();

  const restoredFixture = manualIntake[1];
  await page
    .locator(`#intake-${restoredFixture.id}`)
    .getByRole("button", { name: "Edit intake", exact: true })
    .click();
  await editDialog
    .getByRole("button", { name: "Cancel intake", exact: true })
    .click();
  await editDialog
    .getByRole("button", { name: "Confirm cancel", exact: true })
    .click();
  await editDialog.waitFor({ state: "hidden" });
  const cancelledIntakes = page.locator("details.cancelled-intakes");
  await cancelledIntakes.locator("summary").click();
  await cancelledIntakes
    .locator(`#intake-${restoredFixture.id}`)
    .getByRole("button", { name: "View cancelled intake", exact: true })
    .click();
  await editDialog
    .getByRole("button", { name: "Restore intake", exact: true })
    .click();
  await editDialog
    .getByRole("button", { name: "Different cut", exact: true })
    .waitFor();
  const rejectedRestore = intakeWrites.at(-1);
  await editDialog
    .getByRole("button", { name: "Different cut", exact: true })
    .click();
  await editDialog.waitFor({ state: "hidden" });
  check(
    "Different-range confirmation preserves a cancelled submission's restore action",
    rejectedRestore.input.action === "restore" &&
      intakeWrites.at(-1).input.action === "restore" &&
      intakeWrites.at(-1).input.allowDifferentRange === true &&
      intakeWrites.at(-1).path === rejectedRestore.path &&
      intakeWrites.at(-1).input.idempotencyKey !==
        rejectedRestore.input.idempotencyKey &&
      restoredFixture.status === "awaiting_processing" &&
      restoredFixture.revision === 3,
  );

  intakeDialog = await openIntake();
  await fillIntake(intakeDialog, {
    url: "https://example.com/synthetic-old-render-intent",
    start: "",
    end: "",
  });
  nextIntakeDuplicateMatches = [
    {
      kind: "render",
      id: "c126a-v1",
      episodeId: "ep-126",
      rangeMatch: "exact",
    },
  ];
  await saveIntake(intakeDialog);
  heldWorkspaceId = "ep-126";
  await intakeDialog
    .getByRole("button", { name: "Open existing", exact: true })
    .click();
  await waitUntil(
    () => heldWorkspaceResponses.length === 1,
    "duplicate render's old episode request",
  );
  await chooseWorkspace("ep-127");
  await page
    .getByRole("heading", { name: "No reviewable clips yet", exact: true })
    .waitFor();
  heldWorkspaceId = null;
  await releaseResponses(heldWorkspaceResponses);
  await chooseWorkspace("ep-126");
  await previousClip.waitFor();
  await page.waitForTimeout(150);
  check(
    "Later episode navigation clears an older duplicate-render open intent",
    (await episodePicker.isVisible()) &&
      (await episodePicker.inputValue()) === "ep-126" &&
      new URL(page.url()).hash === "" &&
      (await page.locator("#review-note,video").count()) === 0 &&
      (await page.locator(".clip-row").count()) === 2,
  );
  check(
    "All manual intake fixture flows avoid provider fetches and production imports",
    externalRequests.length === 0 && imports.length === automaticImportStart,
  );
  await capture("episode-manual-intake-slate");

  // Additional visual-only evidence: the app's built-in five-record fictional demo.
  // This does not replace API/media fixture checks or establish live integration.
  const demoUrl = new URL(
    process.env.TEST_BASE_URL || "http://127.0.0.1:5173/",
  );
  demoUrl.search = "?demo=1";
  await page.goto(demoUrl.toString());
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".clip-row").length === 5 &&
      Array.from(document.querySelectorAll(".clip-row img")).every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
  );
  await page
    .getByText("LOCAL DEMO · FICTIONAL SAMPLES", { exact: true })
    .waitFor();
  await capture("demo-slate");
  await page
    .getByRole("button", { name: /^Review / })
    .first()
    .click();
  await page
    .getByText("LOCAL DEMO · NO VIDEO LOADED", { exact: true })
    .waitFor();
  await capture("demo-review");
} catch (e) {
  check("Harness completed", false, String(e));
}
holdStatusResponses = false;
holdEpisodeResponses = false;
heldWorkspaceId = null;
holdIntakeReads = false;
await releaseResponses(heldStatusResponses);
await releaseResponses(heldEpisodeResponses);
await releaseResponses(heldWorkspaceResponses);
await releaseResponses(heldIntakeResponses);
await releaseResponses(heldIntakeWrites);
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/browser-regression.json",
  JSON.stringify(results, null, 2),
);
if (results.some((r) => !r.pass))
  await page
    .screenshot({ path: "test-results/browser-failure.png", fullPage: true })
    .catch(() => {});
await browser.close();
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.some((r) => !r.pass) ? 1 : 0;
