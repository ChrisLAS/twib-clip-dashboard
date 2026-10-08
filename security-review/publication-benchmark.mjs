/** Local workerd wall-time smoke benchmark; NOT production billed CPU evidence. */
import { readFileSync } from "node:fs";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { performance } from "node:perf_hooks";
const source = `import {parseSrt,parseFeed,parseChapters} from './apps/worker/src/publication-parsers.ts';
import {sha256} from './apps/worker/src/publication.ts';
export default {async fetch(request){const input=await request.json();const cues=parseSrt(input.srt);const originalHash=await sha256(input.srt);const normalizedHash=await sha256(JSON.stringify(cues));const feed=parseFeed(input.feed);await sha256(input.feed);await sha256(JSON.stringify(feed));const chapters=parseChapters(input.chapters);await sha256(input.chapters);await sha256(JSON.stringify(chapters));return Response.json({cues:cues.length,originalHash,normalizedHash,episodes:feed.length,chapters:chapters.length});}};`;
const bundle = await build({
  stdin: {
    contents: source,
    resolveDir: process.cwd(),
    sourcefile: "publication-benchmark.ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
const mf = new Miniflare({
  workers: [
    {
      config: {
        name: "publication-benchmark",
        compatibilityDate: "2026-10-01",
        manifest: {
          mainModule: "index.js",
          modules: {
            "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
          },
        },
      },
    },
  ],
});
function stamp(ms) {
  const seconds = Math.floor(ms / 1000);
  return (
    [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map((v) => String(v).padStart(2, "0"))
      .join(":") +
    "," +
    String(ms % 1000).padStart(3, "0")
  );
}
const generatedSrt = Array.from(
  { length: 3500 },
  (_, i) =>
    `${i + 1}\n${stamp(i * 1500)} --> ${stamp(i * 1500 + 1400)}\nFictional benchmark speech about different scientific ideas.\n`,
).join("\n");
const srt = process.argv[3]
  ? readFileSync(process.argv[3], "utf8")
  : generatedSrt;
const rss = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : "<rss><channel><item><guid>benchmark</guid><title>Fictional benchmark</title><itunes:episode>7</itunes:episode></item></channel></rss>";
const input = JSON.stringify({
  srt,
  feed: rss,
  chapters: JSON.stringify({
    chapters: Array.from({ length: 80 }, (_, i) => ({
      startTime: i * 60,
      title: "Fictional chapter " + i,
    })),
  }),
});
const samples = [];
let output;
try {
  for (let i = 0; i < 26; i++) {
    const start = performance.now();
    const response = await mf.dispatchFetch("http://benchmark.local/", {
      method: "POST",
      body: input,
    });
    output = await response.json();
    if (i) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        runtime: "local workerd via Miniflare",
        measurement:
          "host-observed request wall time including IPC, JSON parse, SRT/RSS/chapters parse, SHA-256 and response; excludes external network and D1; NOT billed CPU",
        transcriptBytes: Buffer.byteLength(srt),
        rssBytes: Buffer.byteLength(rss),
        iterations: samples.length,
        p50WallMs: Number(samples[Math.floor(samples.length * 0.5)].toFixed(2)),
        p95WallMs: Number(
          samples[Math.floor(samples.length * 0.95)].toFixed(2),
        ),
        maxWallMs: Number(samples.at(-1).toFixed(2)),
        result: output,
      },
      null,
      2,
    ),
  );
} finally {
  await mf.dispose();
}
