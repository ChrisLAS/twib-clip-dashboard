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
const requests = [];
const googleRequests = [];
page.on("request", (request) => {
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
  let body;
  if (path === "/api/session")
    body = {
      csrfToken: "fixture",
      mode: "production",
      owner: "Test owner",
      integrations: { drive: true, producer: true },
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
  } else if (path === "/api/episodes") body = [episode];
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
await releaseResponses(heldStatusResponses);
await releaseResponses(heldEpisodeResponses);
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
