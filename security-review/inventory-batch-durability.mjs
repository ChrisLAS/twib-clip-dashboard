/* global window, document, localStorage, sessionStorage, Storage */
import console from "node:console";
import process from "node:process";
import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const root = await mkdtemp(join(tmpdir(), "twib-outbox-browser-"));
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
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
  args: ["--no-sandbox", "--disable-background-networking"],
});
async function pageFor(width) {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  await p.goto("file://" + join(root, "index.html"));
  return p;
}
async function settled(p) {
  await p.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "Clear batch",
      )?.disabled === false,
  );
}
try {
  for (const width of [1440, 390]) {
    for (const mode of ["lost", "midbatch"]) {
      const p = await pageFor(width);
      await p.getByRole("checkbox").nth(0).check();
      await p.getByRole("checkbox").nth(1).check();
      await p.getByRole("button", { name: "Page two" }).click();
      await p.getByRole("checkbox").check();
      if (mode === "midbatch")
        await p.evaluate(() => {
          sessionStorage.setItem("fixture-hold", "item_" + "2".repeat(64));
          sessionStorage.setItem("fixture-failed", "true");
        });
      await p.getByRole("button", { name: "Save cutdown requests" }).click();
      if (mode === "midbatch")
        await p.waitForFunction(
          () =>
            window.writes.length === 2 &&
            Object.keys(
              JSON.parse(sessionStorage.getItem("fixture-receipts") ?? "{}"),
            ).length === 2,
        );
      else {
        await p.waitForFunction(() => window.writes.length === 3);
        await p
          .getByRole("button", { name: "Retry unconfirmed requests" })
          .waitFor();
      }
      const before = await p.evaluate(() =>
        JSON.parse(
          localStorage.getItem(
            Object.keys(localStorage).find((k) =>
              k.startsWith("twib.batch-outbox"),
            ),
          ),
        ),
      );
      assert.deepEqual(
        before.entries.map((e) => e.status),
        mode === "midbatch"
          ? ["saved", "pending", "pending"]
          : ["saved", "pending", "saved"],
      );
      await p.reload();
      await p.evaluate(() => sessionStorage.removeItem("fixture-hold"));
      await p
        .getByRole("button", { name: "Retry unconfirmed requests" })
        .click();
      await settled(p);
      const writes = await p.evaluate(() => window.writes);
      assert.equal(writes.length, 4);
      assert.deepEqual(writes[1], writes[mode === "midbatch" ? 2 : 3]);
      if (mode === "midbatch")
        assert.deepEqual(writes[3], before.entries[2].payload);
      assert.equal(
        await p.evaluate(
          () =>
            Object.keys(
              JSON.parse(sessionStorage.getItem("fixture-receipts") ?? "{}"),
            ).length,
        ),
        3,
      );
      await p.getByRole("button", { name: "Change owner" }).click();
      assert.equal(
        await p
          .getByRole("region", { name: "Selected cutdown", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await p.evaluate(
          () =>
            Object.keys(localStorage).filter((k) =>
              k.startsWith("twib.batch-outbox"),
            ).length,
        ),
        1,
      );
      await p.close();
    }
    const p = await pageFor(width);
    await p.getByRole("checkbox").nth(0).check();
    await p.getByRole("button", { name: "Draft first clip" }).click();
    await p.getByRole("button", { name: "Page two" }).click();
    await p.getByRole("button", { name: "Save cutdown requests" }).click();
    assert.match(await p.getByRole("alert").innerText(), /unsaved review/);
    assert.equal(await p.evaluate(() => window.writes.length), 0);
    await p.close();
    for (const failure of ["quota", "corrupt", "owner", "denied"]) {
      const bad = await pageFor(width);
      if (failure === "quota") {
        await bad.getByRole("checkbox").nth(0).check();
        await bad.evaluate(() => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (k, v) {
            if (k.startsWith("twib.batch-outbox")) throw new Error("quota");
            return original.call(this, k, v);
          };
        });
        await bad
          .getByRole("button", { name: "Save cutdown requests" })
          .click();
        assert.match(await bad.getByRole("alert").innerText(), /quota/);
      } else {
        if (failure === "denied") {
          await bad.addInitScript(() => {
            const original = Storage.prototype.getItem;
            Storage.prototype.getItem = function (k) {
              if (k.startsWith("twib.batch-outbox")) throw new Error("denied");
              return original.call(this, k);
            };
          });
        } else {
          await bad.getByRole("checkbox").nth(0).check();
          await bad
            .getByRole("button", { name: "Save cutdown requests" })
            .click();
          await settled(bad);
          await bad.evaluate((mode) => {
            const key = Object.keys(localStorage).find((k) =>
              k.startsWith("twib.batch-outbox"),
            );
            const box = JSON.parse(localStorage.getItem(key));
            box.owner = "other-owner";
            localStorage.setItem(
              key,
              mode === "corrupt" ? "{" : JSON.stringify(box),
            );
            sessionStorage.removeItem("fixture-writes");
          }, failure);
        }
        await bad.reload();
        assert.equal(
          await bad
            .getByRole("button", { name: "Save cutdown requests" })
            .isDisabled(),
          true,
        );
        assert.match(
          await bad.getByRole("alert").innerText(),
          /cannot be read safely/,
        );
      }
      assert.equal(await bad.evaluate(() => window.writes.length), 0);
      await bad.close();
    }
  }
  console.log(
    "Durable batch browser tests passed: desktop/mobile lost-response reload, midbatch reload, exact UUID/payload replay, no duplicate server effects, unsent retention, saved skip, off-page drafts, quota/denied/corrupt storage and owner isolation.",
  );
} finally {
  await browser.close();
}
