#!/usr/bin/env node
/* global process, console */
// Node 24+. Offline only: this command never sends private data or opens URLs.
import { readFile, writeFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { produceAiringCandidate } from "../src/producer.ts";
const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4)
  throw new Error(
    "Usage: node packages/matching/bin/candidate.mjs private-input.json private-output.json",
  );
if ((await stat(input)).size > 2_000_000)
  throw new Error("Input exceeds 2 MB safety bound");
const candidate = produceAiringCandidate(
  JSON.parse(await readFile(input, "utf8")),
  randomUUID(),
);
await writeFile(output, JSON.stringify(candidate, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  `Wrote ${candidate.status}; ${candidate.passages.length} candidate passages. Nothing was submitted or confirmed.`,
);
