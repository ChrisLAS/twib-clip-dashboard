/* global window, document */
import console from "node:console";
import process from "node:process";
import { build } from "esbuild";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const root = await mkdtemp(join(tmpdir(), "twib-batch-browser-"));
await build({
  entryPoints: ["security-review/inventory-batch-fixture.tsx"],
  bundle: true,
  outdir: root,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
await writeFile(
  join(root, "index.html"),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="./inventory-batch-fixture.css"></head><body><div id="root"></div><script src="./inventory-batch-fixture.js"></script></body></html>',
);
await mkdir("test-results", { recursive: true });
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  headless: true,
  args: ["--no-sandbox", "--disable-background-networking"],
});
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("file://" + join(root, "index.html"));
    await page.getByRole("checkbox").nth(0).check();
    await page.getByRole("checkbox").nth(1).check();
    await page.getByRole("button", { name: "Page two" }).click();
    await page.getByRole("checkbox").check();
    assert.equal(
      await page
        .getByRole("region", { name: "Selected cutdown", exact: true })
        .count(),
      3,
    );
    await page.screenshot({
      path: "test-results/batch-selected-" + width + ".png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Save cutdown requests" }).click();
    await page
      .getByRole("button", { name: "Retry unconfirmed requests" })
      .waitFor();
    await page.waitForFunction(() => window.writes.length === 3);
    await page.waitForFunction(
      () =>
        !document
          .querySelector("button[disabled]")
          ?.textContent?.includes("Saving requests"),
    );
    assert.equal(
      await page.getByRole("button", { name: "Clear batch" }).isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "Retry unconfirmed requests" })
      .click();
    await page.waitForFunction(() => window.writes.length === 4);
    await page.getByRole("button", { name: "Clear batch" }).waitFor();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent === "Clear batch",
        )?.disabled === false,
    );
    const writes = await page.evaluate(() => window.writes);
    assert.equal(writes[1].operationId, writes[3].operationId);
    assert.equal(writes[0].cutSpec.kind, "first_pass");
    assert.equal(writes[0].notes, "original note");
    assert.equal(writes.filter((w) => w.itemId === writes[0].itemId).length, 1);
    await page.getByRole("button", { name: "Clear batch" }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[aria-label="Selected cutdown"]').length ===
        0,
    );
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Change source" }).click();
    await page.getByRole("button", { name: "Save cutdown requests" }).click();
    assert.match(await page.getByRole("alert").innerText(), /changed/);
    assert.equal((await page.evaluate(() => window.writes)).length, 4);
    await page.getByRole("button", { name: "Clear batch" }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[aria-label="Selected cutdown"]').length ===
        0,
    );
    await page.getByRole("checkbox").check();
    await page.evaluate(() => {
      window.rejectNext = true;
    });
    await page.getByRole("button", { name: "Save cutdown requests" }).click();
    await page.getByText(/Request rejected: Source changed/).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Clear batch" }).isDisabled(),
      false,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Retry unconfirmed requests" })
        .isDisabled(),
      true,
    );
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: "test-results/batch-result-" + width + ".png",
      fullPage: true,
    });
    await page.close();
  }
  console.log(
    "Batch browser regression passed: desktop/mobile selection across pages, optional instructions, partial failure, stable retry, stale guard, rejection recovery.",
  );
} finally {
  await browser.close();
}
