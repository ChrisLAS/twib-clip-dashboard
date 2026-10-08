import { URL } from "node:url";
/** Run on a non-demo review page with a selected render, before expanding panels.
 * All data here is synthetic. Does not make real mutations.
 * Usage: await runWorkflowBrowserRegression({page,check,renderId,episodeId});
 */
export async function runWorkflowBrowserRegression({
  page,
  check,
  renderId,
  episodeId,
}) {
  const json = (route, value) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  const profile = {
    version: 0,
    enabled: true,
    rules: [],
    feedback: [],
    proposals: [],
    updatedAt: null,
  };
  const editorialWrites = [];
  const profileSnapshots = new Map([[0, []]]);
  let editorialReads = 0;
  let receipts = 0;
  let loseEditorial = true;
  const editorialHandler = async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      if (path.endsWith("/receipts")) {
        receipts++;
        return json(route, {});
      }
      editorialWrites.push(route.request().postDataJSON());
      if (loseEditorial) {
        loseEditorial = false;
        return route.abort("failed");
      }
      const input = editorialWrites.at(-1);
      profile.version += 1;
      profile.rules =
        input.action === "undo"
          ? JSON.parse(JSON.stringify(profileSnapshots.get(input.undoVersion)))
          : (input.rules ?? profile.rules);
      profileSnapshots.set(
        profile.version,
        JSON.parse(JSON.stringify(profile.rules)),
      );
      return json(route, profile);
    }
    editorialReads++;
    return json(
      route,
      path.endsWith("/context")
        ? {
            profileVersion: profile.version,
            enabled: true,
            episodeId,
            renderId,
            rules: profile.rules,
            evidenceIds: [],
            contextHash: "a".repeat(64),
            changedBecauseFeedback: false,
            reviewExamples: [],
            coverage: {
              reviewCount: 0,
              explicitReasonCount: 0,
              blankReasonCount: 0,
              inferredRules: 0,
              examplesTruncated: false,
            },
            lastReceipt: null,
            loadedStatus: "no_receipt",
          }
        : profile,
    );
  };
  await page.route("**/api/editorial/**", editorialHandler);
  const evidence = ["air-first", "air-second"].map((id, index) => ({
    id,
    renderId,
    episodeId: index === 0 ? episodeId : `${episodeId}-target-2`,
    renderArtifactHash: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    episodeEditionFingerprint: (index === 0 ? "c" : "e").repeat(64),
    episodeTranscriptHash: (index === 0 ? "d" : "f").repeat(64),
    algorithmVersion: "bounded-passage-v1",
    status: "UNKNOWN",
    reason: "no_distinctive_match",
    sourceCoordinateSpace: "clip_render",
    exactRenderIdentity: "not_established_by_text",
    searchComplete: true,
    passages: [],
    revision: 0,
    decision: "unknown",
    note: "",
    verifiedAt: null,
    createdAt: "2026-10-08T00:00:00Z",
    freshness: "current",
    staleReason: null,
  }));
  let airingReads = 0;
  const airingWrites = [];
  const airingWriteTargets = [];
  let loseAiring = true;
  const airingRead = async (route) => {
    airingReads++;
    return json(route, {
      renderId,
      sourceFingerprint: "b".repeat(64),
      evidence,
      matching: "offline_candidate_ingestion",
      exactRenderIdentity: "requires_owner_verification",
    });
  };
  const airingWrite = async (route) => {
    const body = route.request().postDataJSON();
    airingWrites.push(body);
    airingWriteTargets.push(new URL(route.request().url()).pathname);
    if (loseAiring) {
      loseAiring = false;
      return route.abort("failed");
    }
    evidence[0].decision = body.decision;
    evidence[0].revision = 1;
    return json(route, {
      id: evidence[0].id,
      revision: 1,
      decision: body.decision,
    });
  };
  await page.route("**/api/renders/*/airing", airingRead);
  await page.route("**/api/airing/*", airingWrite);
  try {
    check(
      "Workflow panels are lazy",
      editorialReads === 0 && airingReads === 0,
    );
    const editorial = page.locator("details").filter({
      has: page.getByText("Editorial profile & feedback", { exact: true }),
    });
    await editorial.locator("summary").click();
    await editorial.getByText(/Version 0/).waitFor();
    await editorial.getByLabel("Scope", { exact: true }).selectOption("global");
    await editorial
      .getByLabel("Explicit reason", { exact: true })
      .fill("Synthetic explicit owner preference");
    await editorial
      .getByLabel("Rule or proposed learning", { exact: true })
      .fill("Synthetic rule for regression only");
    await editorial
      .getByRole("button", { name: "Add approved rule", exact: true })
      .click();
    await editorial
      .getByRole("button", { name: "Retry exact save", exact: true })
      .waitFor();
    await editorial
      .getByRole("button", { name: "Retry exact save", exact: true })
      .click();
    await editorial.getByText(/Version 1/).waitFor();
    check(
      "Editorial uncertain retry retains identical request and future scope",
      editorialWrites.length === 2 &&
        JSON.stringify(editorialWrites[0]) ===
          JSON.stringify(editorialWrites[1]) &&
        editorialWrites[0].scope === "global",
    );
    check(
      "Opening and editing profile never manufactures use receipt",
      receipts === 0 &&
        (await editorial
          .getByText("No producer-use receipt for this context", {
            exact: false,
          })
          .count()) > 0,
    );
    const originalRuleId = profile.rules[0].id;
    await editorial.getByRole("button", { name: "Edit", exact: true }).click();
    await editorial
      .getByLabel("Explicit reason", { exact: true })
      .fill("Synthetic edit reason");
    await editorial
      .getByLabel("Rule or proposed learning", { exact: true })
      .fill("Edited synthetic rule");
    await editorial
      .getByRole("button", { name: "Save rule edit", exact: true })
      .click();
    await editorial.getByText(/Version 2/).waitFor();
    check(
      "Editorial edit keeps rule identity, scope and count",
      profile.rules.length === 1 &&
        profile.rules[0].id === originalRuleId &&
        profile.rules[0].scope === "global" &&
        profile.rules[0].episodeId === null &&
        profile.rules[0].text === "Edited synthetic rule",
    );
    check(
      "Editorial successful edit exits stale edit mode",
      (await editorial
        .getByRole("button", { name: "Add approved rule", exact: true })
        .count()) === 1,
    );
    await editorial
      .getByLabel("Explicit reason", { exact: true })
      .fill("Synthetic remove reason");
    await editorial
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await editorial.getByText(/Version 3/).waitFor();
    check(
      "Editorial remove replaces only the selected rule",
      profile.rules.length === 0,
    );
    await editorial
      .getByLabel("Explicit reason", { exact: true })
      .fill("Synthetic restore reason");
    await editorial
      .getByRole("button", {
        name: "Restore previous version’s rules",
        exact: true,
      })
      .click();
    await editorial.getByText(/Version 4/).waitFor();
    check(
      "Editorial undo writes a new version and restores exact rule identity",
      editorialWrites.at(-1).action === "undo" &&
        editorialWrites.at(-1).undoVersion === 2 &&
        profile.rules.length === 1 &&
        profile.rules[0].id === originalRuleId,
    );
    const airing = page.locator("details").filter({
      has: page.getByText("Airing evidence & owner verification", {
        exact: true,
      }),
    });
    await airing.locator("summary").click();
    await airing.locator("article").first().waitFor();
    const articles = airing.locator("article");
    const exactPlaybackLabel = (row) =>
      `I compared this exact clip render with published playback of episode ${row.episodeId}, edition ${row.episodeEditionFingerprint.slice(0, 12)}, transcript ${row.episodeTranscriptHash.slice(0, 12)}.`;
    for (const [index, row] of evidence.entries()) {
      const article = articles.nth(index);
      check(
        `Airing target ${index + 1} has a distinct visible episode identity and edition`,
        (await article
          .getByText(
            index === 0
              ? `Target: Episode 1 · Fixture episode (${row.episodeId})`
              : `Target: Episode ${row.episodeId}`,
            { exact: true },
          )
          .isVisible()) &&
          (await article
            .getByText(
              `Publication edition: ${row.episodeEditionFingerprint.slice(0, 12)} · Transcript version: ${row.episodeTranscriptHash.slice(0, 12)} · current`,
              { exact: true },
            )
            .isVisible()),
      );
      const checkbox = article.getByRole("checkbox", {
        name: exactPlaybackLabel(row),
        exact: true,
      });
      check(
        `Airing target ${index + 1} checkbox explicitly identifies episode, edition and transcript`,
        (await checkbox.isVisible()) &&
          (await checkbox.isEnabled()) &&
          !(await checkbox.isChecked()),
      );
      const fingerprints = article.locator("details");
      await fingerprints
        .getByText("Full publication fingerprints", { exact: true })
        .click();
      check(
        `Airing target ${index + 1} full fingerprints are inspectable`,
        (await fingerprints
          .getByText(`Episode ID: ${row.episodeId}`, { exact: true })
          .isVisible()) &&
          (await fingerprints
            .getByText(
              `Publication edition: ${row.episodeEditionFingerprint}`,
              {
                exact: true,
              },
            )
            .isVisible()) &&
          (await fingerprints
            .getByText(`Published transcript: ${row.episodeTranscriptHash}`, {
              exact: true,
            })
            .isVisible()),
      );
    }
    check(
      "Unknown evidence cannot be confirmed without exact playback check",
      await articles
        .first()
        .getByRole("button", {
          name: `Confirm full use in ${evidence[0].episodeId}`,
          exact: true,
        })
        .isDisabled(),
    );
    await articles
      .first()
      .getByRole("checkbox", {
        name: exactPlaybackLabel(evidence[0]),
        exact: true,
      })
      .check();
    check(
      "Exact playback check is bound to one evidence edition",
      !(await articles
        .first()
        .getByRole("button", {
          name: `Confirm full use in ${evidence[0].episodeId}`,
          exact: true,
        })
        .isDisabled()) &&
        (await articles
          .nth(1)
          .getByRole("button", {
            name: `Confirm full use in ${evidence[1].episodeId}`,
            exact: true,
          })
          .isDisabled()),
    );
    await articles
      .first()
      .getByRole("button", {
        name: `Confirm partial use in ${evidence[0].episodeId}`,
        exact: true,
      })
      .click();
    await airing
      .getByRole("button", { name: "Retry confirmation", exact: true })
      .waitFor();
    await airing
      .getByRole("button", { name: "Retry confirmation", exact: true })
      .click();
    await articles
      .first()
      .getByText(/owner decision: partial/)
      .waitFor();
    check(
      "Airing uncertain retry preserves exact request",
      airingWrites.length === 2 &&
        JSON.stringify(airingWrites[0]) === JSON.stringify(airingWrites[1]) &&
        airingWriteTargets.every(
          (target) => target === `/api/airing/${evidence[0].id}`,
        ),
    );
    check(
      "Airing refresh resets exact verification",
      !(await articles.first().getByRole("checkbox").isChecked()),
    );
    evidence[1].freshness = "stale";
    evidence[1].staleReason = "Synthetic target publication edition changed";
    await airing
      .getByRole("button", { name: "Refresh airing evidence", exact: true })
      .click();
    await articles
      .nth(1)
      .getByText(evidence[1].staleReason, { exact: true })
      .waitFor();
    await articles
      .first()
      .getByRole("checkbox", {
        name: exactPlaybackLabel(evidence[0]),
        exact: true,
      })
      .check();
    check(
      "Stale target cannot be verified or confirmed after selecting another target",
      (await articles
        .nth(1)
        .getByRole("checkbox", {
          name: exactPlaybackLabel(evidence[1]),
          exact: true,
        })
        .isDisabled()) &&
        (await articles
          .nth(1)
          .getByRole("button", {
            name: `Confirm full use in ${evidence[1].episodeId}`,
            exact: true,
          })
          .isDisabled()) &&
        (await articles
          .nth(1)
          .getByRole("button", {
            name: `Confirm partial use in ${evidence[1].episodeId}`,
            exact: true,
          })
          .isDisabled()),
    );
  } finally {
    await page.unroute("**/api/editorial/**", editorialHandler);
    await page.unroute("**/api/renders/*/airing", airingRead);
    await page.unroute("**/api/airing/*", airingWrite);
  }
}

export async function runPublicationBrowserRegression({ page, check }) {
  let reads = 0,
    writes = 0;
  const asset = {
    state: "ready",
    checkedAt: "2026-10-08T00:00:00Z",
    fetchedAt: "2026-10-08T00:00:00Z",
    hash: "a".repeat(64),
    error: null,
    nextRetryAt: null,
    failureCount: 0,
  };
  const status = {
    configured: true,
    running: false,
    lastAttemptAt: "2026-10-08T00:00:00Z",
    lastSuccessAt: "2026-10-08T00:00:00Z",
    lastScheduledSuccessAt: null,
    nextCheckAt: null,
    lastError: "Some publication assets need attention",
    latest: { title: "Synthetic publication", episodeNumber: 1 },
    assets: {
      rss: asset,
      transcript: {
        ...asset,
        state: "blocked",
        error: "Public source access is blocked (HTTP 403).",
        failureCount: 1,
      },
      chapters: asset,
    },
  };
  const handler = async (route) => {
    if (route.request().method() === "POST") writes++;
    else reads++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(status),
    });
  };
  await page.route("**/api/publication{,/sync}", handler);
  // Playwright's glob brace support keeps these routes exact and synthetic.
  try {
    check("Publication status is lazy", reads === 0 && writes === 0);
    const panel = page.locator("details").filter({
      has: page.getByText("Published episode · RSS, transcript & chapters", {
        exact: true,
      }),
    });
    await panel.locator("summary").click();
    await panel.getByText(/Synthetic publication/).waitFor();
    check(
      "Publication blocked transcript is visible independently of ready chapters",
      (await panel.getByText(/transcript: blocked/).isVisible()) &&
        (await panel.getByText(/chapters: ready/).isVisible()),
    );
    check(
      "Manual metadata success does not claim scheduled success",
      await panel
        .getByText("Last observed scheduled success: Not observed yet", {
          exact: true,
        })
        .isVisible(),
    );
    await panel
      .getByRole("button", { name: "Check public feed now", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Check public feed now", exact: true })
      .waitFor();
    check(
      "Manual feed check is explicit and isolated",
      writes === 1 && reads === 1,
    );
    await panel.locator("summary").click();
  } finally {
    await page.unroute("**/api/publication{,/sync}", handler);
  }
}
