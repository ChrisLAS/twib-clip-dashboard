/* global process, console, sessionStorage, localStorage, Storage, navigator, window */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const temporary = await mkdtemp(join(tmpdir(), "intake-work-synthetic-"));
const fixture = {
  id: "synthetic-intake",
  episodeId: "synthetic-episode",
  kind: "full_source",
  submittedUrl: "https://example.com/synthetic",
  canonicalUrl: "https://example.com/synthetic",
  provider: "other",
  inMs: null,
  outMs: null,
  whyItMatters: "",
  status: "awaiting_processing",
  revision: 1,
  createdAt: "2026-10-16T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z",
};
await build({
  stdin: {
    contents: `import React, { useState } from "react"; import { createRoot } from "react-dom/client";
      import { IntakeWorkPanel } from "./src/intake-work-panel";
      function Harness() {
        const [busy, setBusy] = useState(false);
        const [owner, setOwner] = useState("synthetic-owner");

        const revision = Number(new URLSearchParams(location.search).get("revision") || "1");
        return <><button onClick={() => setOwner(previous => previous === "synthetic-owner" ? "other-owner" : "synthetic-owner")}>Switch owner</button><IntakeWorkPanel owner={owner} items={[{ ...${JSON.stringify(fixture)}, revision }]} csrf="synthetic-csrf"
          demo={false} hidden={false} disabled={busy} onBusy={setBusy}/></>;
      }
      createRoot(document.getElementById("root")).render(<Harness/>);`,
    resolveDir: resolve("apps/web"),
    loader: "tsx",
  },
  bundle: true,
  jsx: "automatic",
  outfile: join(temporary, "fixture.js"),
});
const bundle = await readFile(join(temporary, "fixture.js"));
const stylesheet = await readFile(resolve("apps/web/src/style.css"));
const server = createServer((req, res) => {
  if (req.url === "/style.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(stylesheet);
    return;
  }
  res.setHeader(
    "Content-Type",
    req.url.startsWith("/fixture.js") ? "text/javascript" : "text/html",
  );
  res.end(
    req.url.startsWith("/fixture.js")
      ? bundle
      : '<link rel="stylesheet" href="/style.css"><main style="padding:24px;max-width:1100px;margin:auto"><div id="root"></div></main><script src="/fixture.js"></script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const screenshotDirectory = process.env.SCREENSHOT_DIR;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
async function screenshot(page, name) {
  if (screenshotDirectory)
    await page.screenshot({
      path: join(screenshotDirectory, name + ".png"),
      fullPage: true,
    });
}
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_BIN ||
      "/nix/store/hdx7y4yy1dlkgdbzxcw1qrk9h02376kw-google-chrome-153.0.8010.47/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  let page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let jobs = [],
    enabled = true,
    failSave = false,
    failRetry = false;
  const saves = [],
    retries = [];
  const makeJob = (body) => ({
    jobId: "synthetic-work",
    intakeId: fixture.id,
    intakeRevision: body.expectedRevision,
    episodeId: fixture.episodeId,
    episodeNumber: 10,
    priority: body.priority,
    state: "saved",
    stage: "saved",
    code: null,
    attempt: 1,
    updatedAt: fixture.updatedAt,
    stale: false,
  });
  await context.route("**/api/intake/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: { enabled, dispatchEnabled: false, jobs } });
    } else if (request.url().endsWith("/retry")) {
      const body = request.postDataJSON();
      retries.push(body);
      if (failRetry) {
        await route.abort("failed");
        return;
      }
      jobs = jobs.map((job) => ({
        ...job,
        attempt: body.expectedAttempt + 1,
        state: "saved",
        stage: "saved",
      }));
      await route.fulfill({ json: jobs[0] });
    } else {
      const body = request.postDataJSON();
      saves.push(body);
      if (failSave) {
        await route.abort("failed");
        return;
      }
      jobs = [makeJob(body)];
      await route.fulfill({ json: jobs[0] });
    }
  });
  await page.goto(base);
  await page.getByText("Requests can be saved.", { exact: false }).waitFor();
  assert.equal(saves.length, 0);
  await page
    .getByRole("button", { name: "Save work request", exact: true })
    .click();
  await page.getByText("Saved · revision 1", { exact: false }).waitFor();
  assert.deepEqual(saves, [{ expectedRevision: 1, priority: "normal" }]);
  await screenshot(page, "saved-processing-disabled");
  await page.reload();
  await page.getByText("Saved · revision 1", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Save work request", exact: true })
      .count(),
    0,
  );

  await page.goto(base + "?revision=2");
  await page.getByText("older immutable revision", { exact: false }).waitFor();
  assert.equal(saves.length, 1, "editing must not auto-submit");
  await page.getByRole("combobox").selectOption("urgent");
  failSave = true;
  await page
    .getByRole("button", { name: "Save work request", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByText("Revision 2 · urgent priority.", { exact: false })
    .waitFor();
  failSave = false;
  await page
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .click();
  await page.getByText("Saved · revision 2", { exact: false }).waitFor();
  assert.deepEqual(saves.slice(1), [
    { expectedRevision: 2, priority: "urgent" },
    { expectedRevision: 2, priority: "urgent" },
  ]);

  jobs = jobs.map((job) => ({
    ...job,
    state: "needs_review",
    stage: "error",
    retryable: true,
    stale: true,
    code: "synthetic_failure",
  }));
  await page.getByRole("button", { name: "Refresh work status" }).click();
  await page.getByText("Status may be stale.", { exact: false }).waitFor();
  failRetry = true;
  await page
    .getByRole("button", { name: "Retry work request", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .waitFor();
  await page.reload();
  failRetry = false;
  await page
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .click();
  await page.getByText("attempt 2", { exact: false }).waitFor();
  assert.deepEqual(retries, [
    { expectedAttempt: 1, expectedTargetId: "synthetic-work" },
    { expectedAttempt: 1, expectedTargetId: "synthetic-work" },
  ]);

  jobs = jobs.map((job) => ({
    ...job,
    state: "needs_review",
    stage: "blocked",
    retryable: false,
  }));
  await page.getByRole("button", { name: "Refresh work status" }).click();
  await page.getByText("Blocked · revision 2", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Retry work request", exact: true })
      .count(),
    0,
  );
  jobs = jobs.map((job) => ({ ...job, retryable: true }));
  await page.getByRole("button", { name: "Refresh work status" }).click();
  failRetry = true;
  await page
    .getByRole("button", { name: "Retry work request", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .waitFor();
  // Server accepted the retry but attempt remains unchanged until worker progress.
  jobs = jobs.map((job) => ({
    ...job,
    state: "queued",
    stage: "queued",
    retryable: false,
  }));
  await page.getByRole("button", { name: "Refresh work status" }).click();
  await page.getByText("Queued · revision 2", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Retry work confirmation", exact: true })
      .count(),
    0,
  );
  failRetry = false;

  // An unconfirmed request belongs to its authenticated owner, even across
  // remounts and closed tabs; changing owner never inherits the replay button.
  await page.goto(base + "?revision=3");
  await page.getByRole("combobox").selectOption("urgent");
  failSave = true;
  await page
    .getByRole("button", { name: "Save work request", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .waitFor();
  await screenshot(page, "immutable-revision-pending-confirmation");
  const beforeOwnerSwap = saves.length;
  await page.getByRole("button", { name: "Switch owner" }).click();
  await page.getByText("Requests can be saved.", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Retry work confirmation", exact: true })
      .count(),
    0,
  );
  assert.equal(saves.length, beforeOwnerSwap);
  await page.getByRole("button", { name: "Switch owner" }).click();
  await page
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .waitFor();
  const nextPage = await context.newPage();
  await page.close();
  page = nextPage;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "?revision=3");
  await page
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .waitFor();
  failSave = false;
  await page
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .click();
  await page.getByText("Saved · revision 3", { exact: false }).waitFor();

  // Exact stale-tab race: B remembers Q1 while A clears Q1 then reserves Q2.
  // B's later Q1 reconciliation must never delete or overwrite A's Q2.
  const raceContext = await browser.newContext();
  const tabA = await raceContext.newPage();
  const tabB = await raceContext.newPage();
  let raceJobs = [];
  let firstQ1 = true;
  const racePosts = [];
  await raceContext.route("**/api/intake/**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { enabled: true, dispatchEnabled: false, jobs: raceJobs },
      });
      return;
    }
    const body = route.request().postDataJSON();
    racePosts.push(body);
    if (body.expectedRevision === 2 || firstQ1) {
      firstQ1 = false;
      await route.abort("failed");
      return;
    }
    raceJobs = [makeJob(body)];
    await route.fulfill({ json: raceJobs[0] });
  });
  await tabA.goto(base);
  await tabA
    .getByRole("button", { name: "Save work request", exact: true })
    .click();
  await tabA
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .waitFor();
  await tabB.goto(base);
  await tabB
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .waitFor();
  await tabA
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .click();
  await tabA.getByText("Saved · revision 1", { exact: false }).waitFor();
  await tabA.goto(base + "?revision=2");
  await tabA
    .getByRole("button", { name: "Save work request", exact: true })
    .click();
  await tabA
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .waitFor();
  const q2Envelope = await tabA.evaluate(() =>
    localStorage.getItem("twib:intake-work:v2:synthetic-owner"),
  );
  assert.equal(JSON.parse(q2Envelope).attempt.expectedRevision, 2);
  await tabB.getByRole("button", { name: "Refresh work status" }).click();
  await tabB.getByRole("alert").waitFor();
  assert.equal(
    await tabB.evaluate(() =>
      localStorage.getItem("twib:intake-work:v2:synthetic-owner"),
    ),
    q2Envelope,
  );
  assert.equal(
    await tabB
      .getByRole("button", { name: "Retry work confirmation", exact: true })
      .isDisabled(),
    true,
  );
  await screenshot(tabB, "stale-tab-preserves-new-pending");
  await tabB.reload();
  await tabB
    .getByText("Revision 2 · normal priority.", { exact: false })
    .waitFor();
  assert.deepEqual(racePosts, [
    { expectedRevision: 1, priority: "normal" },
    { expectedRevision: 1, priority: "normal" },
    { expectedRevision: 2, priority: "normal" },
  ]);
  await raceContext.close();

  // Hold the real browser lock, switch account while reserve is suspended,
  // then release: the old owner's durable intent must survive without a POST.
  const lockContext = await browser.newContext();
  const lockPage = await lockContext.newPage();
  let lockPosts = 0;
  await lockContext.route("**/api/intake/**", async (route) => {
    if (route.request().method() !== "GET") lockPosts++;
    await route.fulfill({
      json: { enabled: true, dispatchEnabled: false, jobs: [] },
    });
  });
  await lockPage.goto(base);
  await lockPage
    .getByText("Requests can be saved.", { exact: false })
    .waitFor();
  await lockPage.evaluate(async () => {
    window.syntheticPostCount = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (init?.method === "POST") window.syntheticPostCount++;
      return originalFetch(input, init);
    };
    await new Promise((acquired) => {
      void navigator.locks.request(
        "twib:intake-work:v2:synthetic-owner",
        async () => {
          await new Promise((release) => {
            window.releaseSyntheticLock = release;
            acquired();
          });
        },
      );
    });
  });
  await lockPage
    .getByRole("button", { name: "Save work request", exact: true })
    .click();
  await lockPage.getByRole("button", { name: "Switch owner" }).click();
  await lockPage
    .getByText("Requests can be saved.", { exact: false })
    .waitFor();
  await lockPage.evaluate(async () => {
    window.releaseSyntheticLock();
    await navigator.locks.request(
      "twib:intake-work:v2:synthetic-owner",
      () => {},
    );
  });
  const ownerLockResult = await lockPage.evaluate(() => ({
    posts: window.syntheticPostCount,
    oldOwner: JSON.parse(
      localStorage.getItem("twib:intake-work:v2:synthetic-owner"),
    ),
    newOwner: localStorage.getItem("twib:intake-work:v2:other-owner"),
  }));
  assert.equal(ownerLockResult.posts, 0);
  assert.equal(lockPosts, 0);
  assert.equal(ownerLockResult.oldOwner.owner, "synthetic-owner");
  assert.deepEqual(ownerLockResult.oldOwner.attempt, {
    kind: "save",
    intakeId: "synthetic-intake",
    expectedRevision: 1,
    priority: "normal",
  });
  assert.equal(ownerLockResult.newOwner, null);
  await lockPage.getByRole("button", { name: "Switch owner" }).click();
  await lockPage
    .getByRole("button", { name: "Retry work confirmation", exact: true })
    .waitFor();
  await lockContext.close();

  enabled = false;
  await page.goto(base + "?revision=4");
  await page
    .getByText("Work requests are disabled.", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Save work request", exact: true })
      .isDisabled(),
    true,
  );
  enabled = true;
  await page.evaluate(() =>
    sessionStorage.setItem(
      "twib:manual-intake:v1:synthetic-intake",
      JSON.stringify({
        editing: "synthetic-intake",
        baselineRevision: 4,
        attempt: null,
        fields: {
          url: "https://example.com/synthetic",
          episodeId: "synthetic-episode",
          kind: "full_source",
          start: "",
          end: "",
          why: "unsaved draft",
        },
      }),
    ),
  );
  await page.reload();
  await page.getByText("Your local draft differs", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Save work request", exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate(() =>
    localStorage.setItem(
      "twib:intake-work:v2:synthetic-owner",
      JSON.stringify({
        version: 2,
        scope: "manual-intake-work",
        owner: "other-owner",
        attempt: {
          kind: "save",
          intakeId: "synthetic-intake",
          expectedRevision: 4,
          priority: "urgent",
        },
      }),
    ),
  );
  await page.reload();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Retry work confirmation", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Save work request", exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate(() =>
    localStorage.setItem("twib:intake-work:v2:synthetic-owner", "{corrupt"),
  );
  await page.reload();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Save work request", exact: true })
      .isDisabled(),
    true,
  );
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Synthetic unavailable storage");
    };
  });
  await page.reload();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Save work request", exact: true })
      .isDisabled(),
    true,
  );
  await screenshot(page, "storage-failclosed");
  assert.deepEqual(errors, []);
  console.log(
    "Intake work browser regression passed: explicit save, disabled dispatch, reload recovery, immutable revisions, retry replay, stale status, feature gate, draft mismatch, owner swap, closed-tab recovery, mismatched/corrupt/unavailable storage.",
  );
} finally {
  await browser?.close();
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
