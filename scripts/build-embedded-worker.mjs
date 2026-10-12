import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";

// Packaging only: no network, deployment, credentials, or environment configuration.
const [workerBundle, assetFile, outputDirectory] = process.argv.slice(2);
if (
  !workerBundle ||
  !assetFile ||
  !outputDirectory ||
  process.argv.length !== 5
)
  throw new Error(
    "Usage: node scripts/build-embedded-worker.mjs WORKER_BUNDLE ASSETS_JSON OUTPUT_DIRECTORY",
  );
const assets = JSON.parse(readFileSync(assetFile, "utf8"));
if (
  !assets ||
  Array.isArray(assets) ||
  typeof assets !== "object" ||
  !Object.hasOwn(assets, "/index.html")
)
  throw new Error("Invalid asset map");
const hashes = [];
for (const [path, value] of Object.entries(assets)) {
  if (
    !path.startsWith("/") ||
    /[%\\?#\x00-\x1f\x7f]/.test(path) ||
    path.startsWith("/api/") ||
    path.startsWith("/media/") ||
    path.split("/").some((p) => p === "." || p === "..") ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "body,type" ||
    typeof value.body !== "string" ||
    typeof value.type !== "string" ||
    /[\r\n]/.test(value.type)
  )
    throw new Error("Invalid asset entry");
  hashes.push({
    path,
    type: value.type,
    bytes: Buffer.byteLength(value.body),
    sha256: createHash("sha256").update(value.body).digest("hex"),
  });
}
const out = resolve(outputDirectory);
mkdirSync(out, { recursive: true });
const receiver = resolve(workerBundle);
if (receiver === resolve(out, "receiver.mjs"))
  throw new Error("Output would overwrite input");
copyFileSync(receiver, resolve(out, "receiver.mjs"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  stdin: {
    contents: `import receiver from "./receiver.mjs";\nimport { embeddedAssets } from ${JSON.stringify(resolve(root, "apps/worker/src/embedded-assets.ts"))};\nconst assets=embeddedAssets(${JSON.stringify(assets)});\nexport default {...receiver, fetch(request,env,ctx) {return receiver.fetch(request,{...env,ASSETS:assets},ctx);}};`,
    resolveDir: out,
    sourcefile: "embedded-wrapper.js",
  },
  outfile: resolve(out, "worker.mjs"),
  bundle: true,
  format: "esm",
  target: "es2022",
  external: ["./receiver.mjs"],
  legalComments: "none",
});
writeFileSync(
  resolve(out, "asset-hashes.json"),
  JSON.stringify(hashes, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    assets: hashes.length,
    receiver_sha256: createHash("sha256")
      .update(readFileSync(receiver))
      .digest("hex"),
  }),
);
