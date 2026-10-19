/* global document, window */
import { build } from "esbuild";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import process from "node:process";
import assert from "node:assert/strict";
import console from "node:console";
// Synthetic component fixture only; no credentials, real media or inventory requests.
const root = await mkdtemp(join(tmpdir(), "twib-manual-edit-"));
await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: "manual-fixture.tsx",
    loader: "tsx",
    contents: `
import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {InventoryManualDerivative} from "./apps/web/src/inventory-manual-derivative";
import "./apps/web/src/inventory.css";
const base={producerRecord:{clip_id:"child",parent_clip_id:"source",manual_derivative:{parent_clip_id:"source",source_in_seconds:10,source_out_seconds:40,source_duration_seconds:90,source_sha256:"a".repeat(64),derivative_sha256:"b".repeat(64),verification:"local-sha256"}},manualDerivativeParent:{state:"available",itemId:"item_parent",ref:'source/<img src=x onerror="bad()">.mp4'}};
function Fixture(){const[state,setState]=useState("available"),[selected,setSelected]=useState("");return <main style={{maxWidth:900,margin:"auto",padding:16}}><h1>Synthetic manual edit review</h1><label>Parent state<select aria-label="Parent state" value={state} onChange={e=>setState(e.target.value)}>{["available","reported","missing","ambiguous","changed"].map(s=><option key={s}>{s}</option>)}</select></label><InventoryManualDerivative record={{...base,manualDerivativeParent:{...base.manualDerivativeParent,state}} as any} onFindParent={setSelected}/><p role="status">{selected ? "Selected "+selected : "No source selected"}</p></main>}
createRoot(document.getElementById("root")!).render(<Fixture/>);
`,
  },
  bundle: true,
  outfile: join(root, "fixture.js"),
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  join(root, "index.html"),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta charset="utf-8"><link rel="stylesheet" href="./fixture.css"></head><body><div id="root"></div><script src="./fixture.js"></script></body></html>',
);
await mkdir("test-results", { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN,
  headless: true,
  args: ["--no-sandbox", "--disable-background-networking"],
});
try {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("file://" + join(root, "index.html"));
    await page.getByRole("heading", { name: "Manual shorter edit" }).waitFor();
    assert.equal(await page.locator("img").count(), 0);
    await page.getByRole("button", { name: "Find source" }).click();
    assert.match(await page.getByRole("status").innerText(), /item_parent/);
    for (const state of ["missing", "ambiguous", "changed"]) {
      await page.getByLabel("Parent state").selectOption(state);
      assert.equal(
        await page.getByRole("button", { name: "Find source" }).count(),
        0,
      );
    }
    await page.getByLabel("Parent state").selectOption("reported");
    await page.getByText(/not available to corroborate/).waitFor();
    await page.getByRole("button", { name: "Find source" }).click();
    await page.getByLabel("Parent state").selectOption("available");
    assert.equal(errors.length, 0, errors.join("\n"));
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "No horizontal overflow",
    );
    await page.screenshot({
      path: `test-results/manual-derivative-${viewport.width}.png`,
      fullPage: true,
    });
    await page.close();
  }
  console.log(
    "Manual derivative Chrome desktop/mobile: passed; synthetic screenshots saved.",
  );
} finally {
  await browser.close();
}
