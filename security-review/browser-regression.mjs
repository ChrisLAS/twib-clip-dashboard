import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
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
    durationMs: 90000,
    createdAt: "2026-10-07T12:00:00Z",
    recipeHash: "fixture",
    artifactHash: "a".repeat(64),
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
      outMs: 190000,
      context: "Fixture",
    },
    mappingVerified: true,
    cues: [
      { id: "cue1", text: "Second passage", startMs: 20000, endMs: 25000 },
    ],
    qa: [],
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
  sync: { lastSuccessAt: null, lastError: null },
  observedAt: "2026-10-07T12:00:00Z",
};
const saves = [];
const media = [];
let fail = false;
await page.route("**/api/**", async (route) => {
  const req = route.request(),
    path = new URL(req.url()).pathname;
  let body;
  if (path === "/api/session")
    body = {
      csrfToken: "fixture",
      mode: "production",
      owner: "Test owner",
      integrations: { drive: true, producer: true },
    };
  else if (path === "/api/episodes") body = [episode];
  else if (path === "/api/episodes/ep-demo") body = episode;
  else if (path.endsWith("/reviews")) {
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
  await route.fulfill({ json: body });
});
await page.route("**/media/**", async (route) => {
  media.push(new URL(route.request().url()).pathname);
  await route.fulfill({
    status: 503,
    body: "Fixture: live private media intentionally unavailable",
  });
});
try {
  await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:5173/");
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .waitFor();
  await capture("desktop-slate");
  await page
    .getByRole("button", { name: "Review Clip c1 by Speaker c1" })
    .click();
  await page.waitForTimeout(200);
  await capture("desktop-review");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("mobile-review");
  await page
    .getByRole("button", { name: "Episode 1", exact: false })
    .first()
    .click();
  await capture("mobile-slate");
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
  await page.locator("video").evaluate((v) => {
    Object.defineProperty(v, "currentTime", {
      configurable: true,
      get() {
        return this._testTime || 0;
      },
      set(n) {
        this._testTime = n;
      },
    });
  });
  await page.getByRole("button", { name: /Second passage/ }).click();
  check(
    "Render-relative transcript seek",
    (await page.locator("video").evaluate((v) => v.currentTime)) === 20,
  );
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
    .getByRole("button", { name: "Refresh record", exact: true })
    .click();
  await page.waitForTimeout(250);
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
} catch (e) {
  check("Harness completed", false, String(e));
}
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
