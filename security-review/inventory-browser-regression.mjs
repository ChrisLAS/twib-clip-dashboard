import { URL } from "node:url";
// Synthetic records only. No producer files, source URLs or live credentials.
export async function runInventoryBrowserRegression({
  browser,
  baseURL,
  episode,
  check,
  syntheticVideo,
}) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  const states = [
    ...Array(15).fill("candidate"),
    ...Array(14).fill("captured_observed"),
    ...Array(6).fill("incomplete"),
    ...Array(13).fill("quarantined"),
  ];
  const receipt = {
    schema: "number-one-inventory-receipt/v2",
    source_id: "nomad:number-one",
    episode_id: `episode_${"1".repeat(64)}`,
    digest: `sha256:${"2".repeat(64)}`,
    scan_id: "00000000-0000-4000-8000-000000000002",
    sequence: 2,
    receipt_id: "00000000-0000-4000-8000-000000000003",
    accepted_at: "2026-01-12T18:30:00Z",
    stored_item_count: 48,
    complete: false,
    scope: "episode_media_and_allowlisted_local_artifacts",
    allow_deletions: false,
    candidate_coverage: "partial",
    observedAt: "2026-01-12T18:00:00Z",
    scanFinishedAt: "2026-01-12T18:02:00Z",
  };
  const items = states.map((status, index) => {
    const id = `item_${index.toString(16).padStart(64, "0")}`;
    return {
      id,
      readiness: "not_evaluated",
      conflictingLatestObservations: false,
      variantsTruncated: false,
      variants: [
        {
          receiptId: receipt.receipt_id,
          sequence: 2,
          observedAt: receipt.observedAt,
          receivedAt: receipt.accepted_at,
          receiptComplete: false,
          receiptScope: receipt.scope,
          item: {
            id,
            kind: status === "candidate" ? "candidate" : "media",
            media:
              status === "candidate"
                ? null
                : {
                    ref: `synthetic/segment-${String(index).padStart(2, "0")}.mp4`,
                    present: true,
                    size_bytes: 12400000 + index,
                    modified_at: "2026-01-12T17:45:00Z",
                    duration_seconds: null,
                  },
            observations: [
              {
                artifact: "synthetic/collector.json",
                status: status === "captured_observed" ? "captured" : status,
                context: {},
                timestamps: {},
              },
            ],
            origins: [],
            processing_status: status,
            ready: false,
            capture_evidence:
              status === "captured_observed"
                ? [
                    {
                      artifact: "synthetic/evidence.json",
                      matches_observed_size: true,
                      content_hash_verified: false,
                      streams_reprobed: false,
                    },
                  ]
                : [],
          },
        },
      ],
    };
  });
  let emptySnapshot = false,
    failInventory = false,
    failSession = false,
    hold = false,
    held = [];
  const requests = [];
  const fixtureEpisode = globalThis.structuredClone(episode);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    requests.push({ path, method: route.request().method() });
    let body;
    if (path === "/api/session") {
      if (failSession)
        return route.fulfill({
          status: 401,
          json: { error: { message: "Synthetic owner session expired" } },
        });
      body = {
        csrfToken: "synthetic",
        mode: "production",
        owner: "Synthetic owner",
        integrations: { drive: false, producer: false, intakeProducer: false },
      };
    } else if (path === "/api/episodes") body = [fixtureEpisode];
    else if (path.startsWith("/api/episodes/")) body = fixtureEpisode;
    else if (path === "/api/intake") body = { version: 0, items: [] };
    else if (path === "/api/catalog/status")
      body = {
        version: 1,
        complete: true,
        observedAt: receipt.accepted_at,
        sync: {
          configured: false,
          running: false,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastError: null,
          stale: false,
          intervalSeconds: 300,
        },
        clips: [],
      };
    else if (path === "/api/inventory") {
      if (hold) await new Promise((resolve) => held.push(resolve));
      if (failInventory)
        return route.fulfill({
          status: 503,
          json: { error: { message: "Synthetic read unavailable" } },
        });
      const status = url.searchParams.get("status"),
        q = (url.searchParams.get("q") || "").toLowerCase(),
        after = url.searchParams.get("after") || "";
      const matches = (emptySnapshot ? [] : items).filter(
        (i) =>
          (!status || i.variants[0].item.processing_status === status) &&
          (!q ||
            JSON.stringify([
              i.id,
              i.variants[0].item.media?.ref,
              "synthetic/collector.json",
            ])
              .toLowerCase()
              .includes(q)),
      );
      const filtered = matches.filter((i) => i.id > after),
        selected = filtered.slice(0, 20);
      body = {
        sourceId: "nomad:number-one",
        episodeId: receipt.episode_id,
        episodeNumber: 127,
        candidateCoverage: "partial",
        ingestion: "disabled",
        ingestionPaused: true,
        identityCaveat:
          "Media IDs change on rename; redacted candidate URLs can merge identities.",
        filters: { status, query: q },
        summary: {
          totalItems: emptySnapshot ? 0 : 48,
          matchedItems: matches.length,
          statusCounts: Object.fromEntries(
            [...new Set(states)].map((s) => [
              s,
              emptySnapshot ? 0 : states.filter((v) => v === s).length,
            ]),
          ),
        },
        latestReceivedAt: receipt.accepted_at,
        latestObservedAt: receipt.observedAt,
        latestReceipt: emptySnapshot
          ? { ...receipt, stored_item_count: 0 }
          : receipt,
        items: selected,
        recentReceipts: [receipt],
        nextCursor: filtered.length > 20 ? selected.at(-1).id : null,
      };
    } else body = {};
    return route.fulfill({ status: 200, json: body });
  });
  if (syntheticVideo)
    await page.route("**/media/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: syntheticVideo,
      }),
    );
  const base = baseURL || "http://127.0.0.1:5173/";
  const inventoryURL = new URL("?view=inventory", base).href;
  try {
    await page.goto(inventoryURL);
    await page.getByText("48 matching records", { exact: true }).waitFor();
    check(
      "Inventory direct URL loads total across paginated records",
      (await page.locator(".inventory-record").count()) === 20 &&
        (await page.getByRole("button", { name: /All records 48/ }).count()) ===
          1,
    );
    check(
      "Inventory clearly paused, partial and not playable",
      (await page.getByText("Ingestion off", { exact: true }).isVisible()) &&
        (await page
          .locator(".inventory-workspace video,.inventory-workspace a")
          .count()) === 0 &&
        (await page.getByText(/Latest snapshot: partial/).isVisible()),
    );
    const maliciousRef = "synthetic/<img src=x onerror=alert(1)>.mp4";
    const originalRef = items[15].variants[0].item.media.ref;
    items[15].variants[0].item.media.ref = maliciousRef;
    await page.getByRole("button", { name: "Refresh stored records" }).click();
    await page.getByText(maliciousRef, { exact: true }).waitFor();
    check(
      "Inventory references are escaped literal text",
      (await page.locator(".inventory-workspace img").count()) === 0,
    );
    items[15].variants[0].item.media.ref = originalRef;
    await page.getByRole("button", { name: "Refresh stored records" }).click();
    await page.getByText(originalRef, { exact: true }).waitFor();
    emptySnapshot = true;
    await page.getByRole("button", { name: "Refresh stored records" }).click();
    await page
      .getByRole("heading", { name: "No inventory records", exact: true })
      .waitFor();
    check(
      "Zero-item receipt does not claim no snapshot arrived",
      await page
        .getByText(/received snapshot contained no records/)
        .isVisible(),
    );
    emptySnapshot = false;
    await page.getByRole("button", { name: "Refresh stored records" }).click();
    await page.getByText("48 matching records", { exact: true }).waitFor();
    await page.screenshot({
      path: "test-results/inventory-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Next records" }).click();
    await page.getByText("Page 2 · up to 20 per page").waitFor();
    await page.locator(".inventory-record").first().waitFor();
    check(
      "Inventory next page keeps server total",
      (await page.locator(".inventory-record").count()) === 20 &&
        (await page
          .getByText("48 matching records", { exact: true })
          .isVisible()),
    );
    await page.getByRole("button", { name: /Quarantined 13/ }).click();
    await page.getByText("13 matching records", { exact: true }).waitFor();
    check(
      "Inventory status filter resets pagination",
      (await page.locator(".inventory-record").count()) === 13 &&
        (await page
          .getByRole("button", { name: "Previous records" })
          .count()) === 0,
    );
    await page.locator(".inventory-record summary").first().focus();
    await page.keyboard.press("Enter");
    check(
      "Inventory keyboard opens provenance and mobile timestamp",
      (await page.locator(".inventory-record[open]").count()) === 1 &&
        (await page
          .locator(".inventory-record[open]")
          .getByText("Observed on source", { exact: true })
          .isVisible()),
    );
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByText("48 matching records", { exact: true }).waitFor();
    await page
      .getByRole("textbox", { name: "Search inventory" })
      .fill("segment-20");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByText("1 matching record for “segment-20”").waitFor();
    check(
      "Inventory searches beyond first page",
      await page
        .getByText("synthetic/segment-20.mp4", { exact: true })
        .isVisible(),
    );
    await page
      .getByRole("textbox", { name: "Search inventory" })
      .fill("does-not-exist");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("heading", { name: "No matching records" }).waitFor();
    check(
      "Inventory empty search is not an empty source claim",
      await page.getByText(/Filters do not change stored records/).isVisible(),
    );
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByText("48 matching records", { exact: true }).waitFor();
    failInventory = true;
    await page.getByRole("button", { name: "Refresh stored records" }).click();
    await page.getByText("Inventory unavailable", { exact: true }).waitFor();
    check(
      "Inventory read failure does not impersonate zero items",
      (await page
        .getByRole("heading", { name: "No inventory received" })
        .count()) === 0,
    );
    failInventory = false;
    await page.getByRole("button", { name: "Retry inventory" }).click();
    await page.getByText("48 matching records", { exact: true }).waitFor();
    hold = true;
    await page.getByRole("button", { name: /Candidate 15/ }).click();
    await page
      .getByRole("button", { name: "Episode slate", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    hold = false;
    held.splice(0).forEach((resolve) => resolve());
    await page
      .getByRole("button", { name: /Review / })
      .first()
      .waitFor();
    check(
      "Leaving inventory cancels stale read without changing slate",
      !(await page.locator(".inventory-workspace").count()),
    );
    await page.goBack();
    await page.getByText("15 matching records", { exact: true }).waitFor();
    check(
      "Browser back restores inventory view and filter",
      new URL(page.url()).searchParams.get("view") === "inventory",
    );
    await page.goForward();
    await page
      .getByRole("button", { name: /Review / })
      .first()
      .waitFor();
    await page
      .getByRole("button", { name: /Review / })
      .first()
      .click();
    check(
      "Inventory entry never interrupts active playback review",
      (await page
        .getByRole("button", { name: "Source inventory", exact: true })
        .filter({ visible: true })
        .count()) === 0,
    );
    const note = page.locator("#review-note");
    await note.fill("Synthetic retained draft");
    await page.locator(".review-breadcrumb button").first().click();
    await page
      .getByRole("button", { name: "Source inventory", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page
      .getByRole("heading", { name: /Collected, not yet curated/ })
      .waitFor();
    await page
      .getByRole("button", { name: "Episode slate", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: /Review / })
      .first()
      .click();
    check(
      "Inventory round trip preserves unsaved render note",
      (await page.locator("#review-note").inputValue()) ===
        "Synthetic retained draft",
    );
    await page.goto(inventoryURL);
    await page.getByText("48 matching records", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    check(
      "Inventory mobile navigation remains available",
      await page
        .locator(".workspace-mobile-nav")
        .getByRole("button", { name: "Source inventory" })
        .isVisible(),
    );
    check(
      "Inventory mobile has no horizontal overflow",
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      ),
    );
    await page.locator(".inventory-record summary").first().click();
    await page.screenshot({
      path: "test-results/inventory-mobile.png",
      fullPage: true,
    });
    failSession = true;
    await page.reload();
    await page.getByRole("button", { name: "Retry owner session" }).waitFor();
    check(
      "Inventory direct URL exposes owner-session failure",
      await page.getByText(/Owner session could not be loaded/).isVisible(),
    );
    failSession = false;
    await page.getByRole("button", { name: "Retry owner session" }).click();
    await page.getByText("48 matching records", { exact: true }).waitFor();
    check(
      "Inventory flow is entirely read-only",
      requests.every((r) => r.method === "GET"),
    );
  } catch (error) {
    check("Inventory browser harness completed", false, String(error));
    await page
      .screenshot({
        path: "test-results/inventory-failure.png",
        fullPage: true,
      })
      .catch(() => {});
  } finally {
    hold = false;
    held.splice(0).forEach((resolve) => resolve());
    await page.close();
  }
}
