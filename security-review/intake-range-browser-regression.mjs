// Synthetic-only component flow. Never talks to a live dashboard or source host.
import process from "node:process";
import console from "node:console";
import { build } from "esbuild";
import { createServer } from "node:http";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const binding = {
  expectedCutRequestId: "00000000-0000-4000-8000-000000000001",
  expectedRequestRevision: "a".repeat(64),
  expectedParentVersion: "b".repeat(64),
  expectedRevision: 1,
  expectedWorkspaceRevision: 1,
  episodeNumber: 128,
};
let job = {
  jobId: "00000000-0000-4000-8000-000000000002",
  intakeId: "synthetic-intake",
  intakeRevision: 1,
  episodeId: "draft",
  episodeNumber: 128,
  priority: "normal",
  state: "needs_review",
  stage: "needs_direction",
  code: null,
  attempt: 0,
  updatedAt: "2026-10-18T00:00:00Z",
  stale: false,
  retryable: false,
  rangeDispatchEnabled: true,
  rangeSelection: binding,
  cutRequest: {
    requestId: binding.expectedCutRequestId,
    state: "needs_review",
    parentVersion: binding.expectedParentVersion,
    spec: { kind: "first_pass" },
    parent: { ref: "new-review/synthetic.mp4" },
    proposal: null,
  },
};
const item = {
  id: "synthetic-intake",
  episodeId: "draft",
  revision: 1,
  status: "awaiting_processing",
  inMs: null,
  outMs: null,
  whyItMatters: "Original notes",
};
const result = await build({
  stdin: {
    contents: `import './apps/web/src/style.css';import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{IntakeWorkPanel}from'./apps/web/src/intake-work-panel';function App(){const[owner,setOwner]=useState('owner-a');return <><button onClick={()=>setOwner(owner==='owner-a'?'owner-b':'owner-a')}>Switch owner</button><IntakeWorkPanel owner={owner} items={[${JSON.stringify(item)}]} csrf="synthetic-csrf" demo={false} disabled={false} hidden={false} onBusy={()=>{}}/></>};createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  outdir: "/tmp/intake-range-browser-bundle",
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
});
const server = createServer((req, res) => {
  if (req.url === "/bundle.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(result.outputFiles.find((f) => f.path.endsWith(".js")).text);
  } else if (req.url === "/bundle.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(result.outputFiles.find((f) => f.path.endsWith(".css")).text);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<link rel="stylesheet" href="/bundle.css"><div id="root"></div><script type="module" src="/bundle.js"></script>',
    );
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const writes = [];
let responseMode = "abort";
let readbackFails = false;
try {
  await page.route("**/api/intake/work", (route) =>
    readbackFails
      ? route.abort()
      : route.fulfill({
          json: { enabled: true, dispatchEnabled: true, jobs: [job] },
        }),
  );
  await page.route("**/api/intake/*/work/*/range", async (route) => {
    const request = route.request();
    writes.push({
      body: request.postDataJSON(),
      csrf: request.headers()["x-csrf-token"],
    });
    if (responseMode === "abort") {
      await route.abort();
      return;
    }
    if (responseMode === "malformed") {
      await route.fulfill({
        json: {
          requestId: "wrong",
          sourcePlanRequestId: "wrong",
          selectionOrigin: "owner_range",
        },
      });
      return;
    }
    if (responseMode === "reject") {
      await route.fulfill({
        status: 409,
        json: { error: { message: "Synthetic changed binding" } },
      });
      return;
    }
    const body = writes.at(-1).body;
    job = {
      ...job,
      state: "queued",
      stage: "queued",
      cutRequest: {
        ...job.cutRequest,
        requestId: "00000000-0000-4000-8000-000000000003",
        sourcePlanRequestId: body.expectedCutRequestId,
        selectionOrigin: "owner_range",
        spec: body.range,
      },
    };
    await route.fulfill({
      json: {
        requestId: "00000000-0000-4000-8000-000000000003",
        sourcePlanRequestId: body.expectedCutRequestId,
        selectionOrigin: "owner_range",
      },
    });
  });
  await page.goto(origin);
  const start = page.getByLabel("Start seconds"),
    end = page.getByLabel("End seconds");
  const save = page.getByRole("button", {
    name: "Save range and queue cut",
    exact: true,
  });
  await start.fill("10");
  await end.fill("300");
  assert.equal(await save.isDisabled(), true);
  await end.fill("30.125");
  assert.equal(await save.isEnabled(), true);
  await page
    .getByRole("button", { name: "Refresh work status", exact: true })
    .click();
  assert.equal(await start.inputValue(), "10");
  await page.reload();
  await start.waitFor();
  assert.equal(await start.inputValue(), "10");
  assert.equal(await end.inputValue(), "30.125");
  assert.equal(writes.length, 0);
  job = { ...job, rangeDispatchEnabled: false };
  await page
    .getByRole("button", { name: "Refresh work status", exact: true })
    .click();
  await page.getByText(/Cut dispatch is disabled/).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await start.inputValue(), "10");
  job = {
    ...job,
    rangeDispatchEnabled: true,
    rangeSelection: { ...binding, expectedWorkspaceRevision: 2 },
  };
  await page
    .getByRole("button", { name: "Refresh work status", exact: true })
    .click();
  await page.getByText(/old draft is preserved/).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await start.inputValue(), "10");
  await page
    .getByRole("button", {
      name: "Discard old range draft and use current source",
    })
    .click();
  assert.equal(await start.inputValue(), "");
  await start.fill("10");
  await end.fill("30.125");
  await page.screenshot({ path: "/tmp/intake-range-form.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      "document.documentElement.scrollWidth <= window.innerWidth",
    ),
    true,
  );
  await page.screenshot({
    path: "/tmp/intake-range-form-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1100, height: 900 });
  await save.dblclick();
  await page
    .getByRole("button", { name: "Retry work confirmation" })
    .and(page.locator(":enabled"))
    .waitFor();
  await page.getByText(/Range confirmation is unresolved/).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.expectedWorkspaceRevision, 2);
  assert.equal(writes[0].csrf, "synthetic-csrf");
  await page.reload();
  await page.getByRole("button", { name: "Retry work confirmation" }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(await start.inputValue(), "10");
  await page.getByRole("button", { name: "Switch owner" }).click();
  await start.waitFor();
  assert.equal(await start.inputValue(), "");
  assert.equal(
    await page.getByRole("button", { name: "Retry work confirmation" }).count(),
    0,
  );
  assert.equal(writes.length, 1);
  await page.getByRole("button", { name: "Switch owner" }).click();
  await page.getByRole("button", { name: "Retry work confirmation" }).waitFor();
  assert.equal(await start.inputValue(), "10");
  responseMode = "malformed";
  readbackFails = true;
  await page.getByRole("button", { name: "Retry work confirmation" }).click();
  await page
    .getByRole("button", { name: "Retry work confirmation" })
    .and(page.locator(":enabled"))
    .waitFor();
  await page.getByText(/Range confirmation is unresolved/).waitFor();
  assert.equal(writes.length, 2);
  assert.equal(
    await page.getByRole("button", { name: "Retry work confirmation" }).count(),
    1,
  );
  responseMode = "reject";
  await page.getByRole("button", { name: "Retry work confirmation" }).click();
  await page
    .getByRole("button", { name: "Retry work confirmation" })
    .and(page.locator(":enabled"))
    .waitFor();
  await page.getByText(/Range confirmation is unresolved/).waitFor();
  assert.equal(writes.length, 3);
  await page.reload();
  await page.getByRole("button", { name: "Retry work confirmation" }).waitFor();
  assert.equal(writes.length, 3);
  readbackFails = false;
  await page
    .getByRole("button", { name: "Refresh work status", exact: true })
    .click();
  await start.waitFor();
  responseMode = "success";
  await page.getByRole("button", { name: "Retry work confirmation" }).click();
  await page.getByText(/Range selection confirmed/).waitFor();
  assert.equal(writes.length, 4);
  assert.ok(
    writes.every((w) => JSON.stringify(w) === JSON.stringify(writes[0])),
  );
  assert.equal(
    await page.getByRole("button", { name: "Retry work confirmation" }).count(),
    0,
  );
  assert.equal(await save.count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: process.env.RANGE_SCREENSHOT || "/tmp/intake-range-confirmed.png",
    fullPage: true,
  });
  console.log(
    "PASS: decimal validation, explicit dispatch gate, reload/refresh preservation, stale binding discard, duplicate click, uncertain response, no auto-send, owner isolation, malformed receipt and rejected-retry retention, exact replay, mobile layout and linked queued readback.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
