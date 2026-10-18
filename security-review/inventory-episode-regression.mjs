/* global window */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import process from "node:process";
import console from "node:console";
const root = await mkdtemp(join(tmpdir(), "twib-episode-browser-"));
await build({
  entryPoints: ["security-review/inventory-episode-fixture.tsx"],
  bundle: true,
  outdir: root,
  define: { "process.env.NODE_ENV": '"production"' },
});
const server = createServer(async (req, res) => {
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<div id="root"></div><script src="/inventory-episode-fixture.js"></script>',
    );
    return;
  }
  const file =
    req.url === "/inventory-episode-fixture.js"
      ? "inventory-episode-fixture.js"
      : null;
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader("Content-Type", "text/javascript");
  res.end(await readFile(join(root, file)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox", "--disable-background-networking"],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.locator(".inventory-record > summary").click();
  await page
    .getByLabel("Clip notes", { exact: true })
    .fill("draft belonging to 127");
  await mkdir(join(root, "127"));
  await writeFile(join(root, "127", "clip-127.mp4"), new Uint8Array([1, 2, 3]));
  await page
    .locator('input[type="file"][multiple]')
    .setInputFiles(join(root, "127"));
  await page.getByText(/1 local files selected/).waitFor();
  await page.evaluate(() => {
    window.episodeTest.hold = true;
  });
  await page.getByRole("button", { name: "Refresh stored records" }).click();
  await page.waitForFunction(() => !!window.episodeTest.release);
  await page
    .getByRole("button", { name: "Workspace 128", exact: true })
    .click();
  await page.getByText("Nomad · TWiB 128 inventory report").waitFor();
  await page.getByText("clip-128.mp4", { exact: true }).first().waitFor();
  assert.equal(await page.getByText(/local files selected/).count(), 0);
  assert.equal(
    await page.evaluate(() =>
      window.episodeTest.reads
        .filter((r) => r.number === 127)
        .every((r) => r.signal.aborted),
    ),
    true,
  );
  await page.evaluate(() => window.episodeTest.release());
  await page.waitForTimeout(50);
  assert.equal(
    await page.getByText("clip-127.mp4", { exact: true }).count(),
    0,
  );
  await page.locator(".inventory-record > summary").click();
  assert.equal(
    await page.getByLabel("Clip notes", { exact: true }).inputValue(),
    "",
  );
  await page.getByLabel("Clip notes", { exact: true }).fill("128 note");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.waitForFunction(() => window.episodeTest.writes.length === 1);
  assert.equal(
    await page.evaluate(() => window.episodeTest.writes[0].episodeNumber),
    128,
  );
  await page.locator(".inventory-batch-choice input").check();
  await page
    .getByRole("button", { name: "Save cutdown requests", exact: true })
    .click();
  await page.waitForFunction(() => window.episodeTest.writes.length === 2);
  assert.equal(
    await page.evaluate(() => window.episodeTest.writes[1].episodeNumber),
    128,
  );
  const tab = await context.newPage();
  await tab.goto(base);
  await tab.getByText("Nomad · TWiB 127 inventory report").waitFor();
  assert.equal(
    await tab
      .getByRole("region", { name: "Selected cutdown", exact: true })
      .count(),
    0,
  );
  await tab.getByRole("button", { name: "Workspace 128", exact: true }).click();
  await tab
    .getByRole("region", { name: "Selected cutdown", exact: true })
    .waitFor();
  assert.equal(await tab.evaluate(() => window.episodeTest.writes.length), 0);
  await tab.getByRole("button", { name: "Other owner" }).click();
  await tab.getByText("clip-128.mp4", { exact: true }).first().waitFor();
  assert.equal(
    await tab
      .getByRole("region", { name: "Selected cutdown", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "No workspace" }).click();
  await page
    .getByText("Choose an episode workspace to view its inventory.")
    .waitFor();
  await page.evaluate(() => {
    window.episodeTest.mismatch = true;
  });
  await page
    .getByRole("button", { name: "Workspace 128", exact: true })
    .click();
  await page.getByText("Inventory unavailable", { exact: true }).waitFor();
  assert.equal(await page.locator(".inventory-record").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 127→128 stale reads/files/drafts, 128 note and batch, scoped cross-tab outboxes, owner isolation, and mismatched response rejection",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
