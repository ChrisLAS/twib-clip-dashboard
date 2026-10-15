/* global document, window */
import console from "node:console";
import process from "node:process";
import { build } from "esbuild";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const root = await mkdtemp(join(tmpdir(), "twib-cut-status-"));
await build({
  entryPoints: ["security-review/inventory-cut-status-fixture.tsx"],
  bundle: true,
  outdir: root,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
await writeFile(
  join(root, "index.html"),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="./inventory-cut-status-fixture.css"></head><body><div id="root"></div><script src="./inventory-cut-status-fixture.js"></script></body></html>',
);
await mkdir("test-results", { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
  args: ["--no-sandbox", "--disable-background-networking"],
});
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("file://" + join(root, "index.html"));
    await page
      .getByText("Episode-context planning is disabled.", { exact: false })
      .waitFor();
    assert.equal(
      await page
        .getByText("Automatic first-pass rendering is disabled;", {
          exact: false,
        })
        .count(),
      1,
    );
    for (const text of [
      "Queued for episode-context planning",
      "Planning cutdown",
      "Cut plan prepared · Unreviewed",
      "Rendering review version",
      "Review version available · Unreviewed",
      "Blocked: episode context unavailable",
      "Cutdown failed",
      "Automatic cut blocked: source or review changed",
    ])
      assert.equal(await page.getByText(text, { exact: true }).count(), 1);
    assert.equal(
      await page
        .getByText("Original: originals/long-source.mp4", { exact: false })
        .count(),
      8,
    );
    assert.equal(
      await page
        .getByText("Proposed source range: 45–165 seconds", { exact: true })
        .count(),
      2,
    );
    assert.equal(await page.getByRole("checkbox").isDisabled(), true);
    assert.equal(
      await page
        .getByText("Source exceeds the 512 MiB cut-job limit.", {
          exact: false,
        })
        .count(),
      1,
    );
    await page.screenshot({
      path: "test-results/cut-status-disabled-" + width + ".png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Toggle fixture gates" }).click();
    await page
      .getByText("Automatic first-pass rendering is enabled;", { exact: false })
      .waitFor();
    await page
      .getByRole("button", { name: "Find imported review version" })
      .click();
    assert.equal(
      await page
        .getByText(
          "Inventory lookup: new-review/synthetic-review-version.mp4",
          { exact: true },
        )
        .count(),
      1,
    );
    assert.equal(
      await page
        .getByText("Original: originals/long-source.mp4", { exact: false })
        .count(),
      8,
    );
    assert.equal(
      await page
        .getByText(
          "The original is retained. Review this new version separately before approving it.",
          { exact: true },
        )
        .count(),
      1,
    );
    await page.getByRole("link").first().click();
    assert.ok(
      page.url().endsWith("#cut-request-00000000-0000-4000-8000-000000000003"),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "test-results/cut-status-enabled-" + width + ".png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "Cut status browser tests passed on desktop/mobile: capability gates, queued/planning/proposed/rendering/ready/blocked/error, context revisions, derivative navigation, source-plan linkage and original preservation.",
  );
} finally {
  await browser.close();
}
