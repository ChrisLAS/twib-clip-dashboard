/* global window */
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
// Runs self-contained file:// fixtures; no HTTP listener or real episode media.
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright";
const root = await mkdtemp(join(tmpdir(), "twib-local-playback-"));
const video = join(root, "synthetic.mp4");
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=10",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=220:sample_rate=22050",
  "-t",
  "3",
  "-c:v",
  "libx264",
  "-threads",
  "1",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-movflags",
  "+faststart",
  video,
]);
const audio = join(root, "synthetic.mp3");
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=330:sample_rate=22050",
  "-t",
  "1",
  "-c:a",
  "libmp3lame",
  audio,
]);
const audioBytes = await readFile(audio);
const bytes = await readFile(video);
await build({
  entryPoints: ["security-review/local-playback-fixture.tsx"],
  bundle: true,
  outdir: root,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  banner: {
    js:
      "window.TEST_BYTES=" +
      JSON.stringify(bytes.toString("base64")) +
      ";window.AUDIO_BYTES=" +
      JSON.stringify(audioBytes.toString("base64")) +
      ";",
  },
});
const html =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:; media-src \'self\' blob:; connect-src \'self\'; object-src \'none\'; base-uri \'none\'"><link rel="stylesheet" href="./local-playback-fixture.css"></head><body><div id="root"></div><script src="./local-playback-fixture.js"></script></body></html>';
await writeFile(join(root, "index.html"), html);
await mkdir("test-results", { recursive: true });
const chrome = await chromium.launch({
  executablePath: "/run/current-system/sw/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-background-networking"],
});
try {
  for (const viewport of [
    { width: 1440, height: 1100 },
    { width: 390, height: 844 },
  ]) {
    const page = await chrome.newPage({ viewport });
    await page.goto("file://" + join(root, "index.html"));
    await page.waitForFunction(() => window.previewReady || window.result, {
      timeout: 15000,
    });
    await page.screenshot({
      path: "test-results/local-player-" + viewport.width + ".png",
      fullPage: true,
    });
    await page.evaluate(() => {
      window.resumePreview = true;
    });
    await page.waitForFunction(() => window.result, { timeout: 15000 });
    const result = await page.evaluate(() => window.result);
    await writeFile(
      "test-results/local-playback-chrome-" + viewport.width + ".json",
      JSON.stringify(result, null, 2),
    );
    await page.screenshot({
      path: "test-results/local-playback-chrome-" + viewport.width + ".png",
      fullPage: true,
    });
    console.log(JSON.stringify({ engine: "Chrome", viewport, ...result }));
    await page.close();
    if (result.error) process.exitCode = 1;
  }
} finally {
  await chrome.close();
}
const profile = join(root, "firefox-profile");
await mkdir(profile);
await writeFile(
  join(profile, "user.js"),
  [
    'user_pref("browser.download.folderList", 2);',
    'user_pref("browser.download.dir", ' + JSON.stringify(root) + ");",
    'user_pref("browser.download.useDownloadDir", true);',
    'user_pref("browser.helperApps.neverAsk.saveToDisk", "application/json");',
    'user_pref("browser.download.always_ask_before_handling_new_types", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
  ].join("\n"),
);
const firefox = spawn(
  "/run/current-system/sw/bin/firefox",
  [
    "--headless",
    "--no-remote",
    "--profile",
    profile,
    "file://" + join(root, "index.html"),
  ],
  { stdio: "ignore" },
);
let report;
try {
  for (let i = 0; i < 300; i++) {
    if ((await readdir(root)).includes("local-playback-report.json")) {
      try {
        report = JSON.parse(
          await readFile(join(root, "local-playback-report.json"), "utf8"),
        );
        break;
      } catch {
        /* file not yet complete */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} finally {
  firefox.kill("SIGTERM");
}
if (report) {
  await writeFile(
    "test-results/local-playback-firefox.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ engine: "Firefox", ...report }));
  if (report.error) process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      engine: "Firefox",
      error: "Synthetic browser report unavailable",
      fixtureRoot: root,
    }),
  );
  process.exitCode = 1;
}
console.log(
  JSON.stringify({ fixtureRoot: root, noListener: true, noRealMedia: true }),
);
