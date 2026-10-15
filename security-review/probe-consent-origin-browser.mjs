import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { chromium } from "playwright";

// Synthetic, local-only reproduction: no real OAuth codes, cookies or identities.
const origin = "https://probe.example.test";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
});
try {
  const page = await browser.newPage();
  for (const policy of ["no-referrer", "same-origin"]) {
    let submittedOrigin;
    await page.route(`${origin}/**`, async (route) => {
      if (route.request().method() === "POST") {
        submittedOrigin = route.request().headers().origin;
        await route.fulfill({
          status: 200,
          body: "Synthetic consent received",
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": policy,
          "Content-Security-Policy":
            "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        },
        body: '<!doctype html><title>Synthetic consent</title><form method="post" action="/authorize"><input name="handle" type="hidden" value="synthetic"><button name="decision" value="approve">Allow</button></form>',
      });
    });
    await page.goto(`${origin}/authorize?test=synthetic`);
    await Promise.all([
      page.waitForURL(`${origin}/authorize`),
      page.getByRole("button", { name: "Allow", exact: true }).click(),
    ]);
    assert.equal(submittedOrigin, policy === "no-referrer" ? "null" : origin);
    console.log(JSON.stringify({ policy, submittedOrigin }));
    await page.unrouteAll({ behavior: "wait" });
  }
} finally {
  await browser.close();
}
