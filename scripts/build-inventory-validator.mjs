// Build-time only: Workers prohibit runtime eval/new Function used by Ajv compilation.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
const root = new URL("../", import.meta.url);
const schema = JSON.parse(
  readFileSync(
    new URL("apps/worker/src/inventory/manifest.schema.json", root),
    "utf8",
  ),
);
const ajv = new Ajv2020({
  code: { source: true, esm: true },
  strict: false,
  allErrors: false,
});
addFormats(ajv);
const envelope = JSON.parse(
  readFileSync(
    new URL("apps/worker/src/inventory/envelope.schema.json", root),
    "utf8",
  ),
);
ajv.addSchema(schema);
ajv.addSchema(envelope);
const { outputFiles } = await build({
  stdin: {
    contents: standaloneCode(ajv, {
      validateManifest: schema.$id,
      validateEnvelope: envelope.$id,
    }),
    resolveDir: new URL(".", root).pathname,
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  write: false,
});
const output =
  "// Generated from manifest.schema.json. Run npm run inventory:validator. Do not edit.\n" +
  outputFiles[0].text;
const destination = new URL(
  "apps/worker/src/inventory/validator.generated.js",
  root,
);
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== output)
    throw new Error("Inventory validator is stale.");
} else writeFileSync(destination, output);
