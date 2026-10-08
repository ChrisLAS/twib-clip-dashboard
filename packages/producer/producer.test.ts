import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { manifestSchema } from "../../apps/worker/src/importer";

describe("portable producer", () => {
  it("passes real rendering, actual SIGKILL resume and safety regressions", () => {
    const result = execFileSync(
      "python3",
      ["-m", "unittest", "discover", "-s", "packages/producer", "-v"],
      { timeout: 60000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(result).toBe("");
  }, 65000);

  it("exports a real rendered bundle compatible with the authoritative manifest schema", () => {
    const script = `
import sys, json
sys.path.insert(0, "packages/producer")
from test_producer import ProducerTests
from finalize_manifest import finalize
ProducerTests.setUpClass()
test = ProducerTests()
test.setUp()
test.job["recordingDate"] = "2026-10-08T00:00:00.123456+00:00"
test.job["publicationDate"] = "2026-10-08T00:00:00-04:00"
try:
    output = test.producer().run()
    bundle = json.loads(output.read_text())
    receipt = {"fileId": "synthetic-drive-id", "sha256": bundle["artifact"]["sha256"], "size": bundle["artifact"]["size"]}
    print(json.dumps(finalize(output, receipt)))
finally:
    test.doCleanups()
    ProducerTests.tearDownClass()
`;
    const output = execFileSync("python3", ["-c", script], {
      timeout: 30000,
      encoding: "utf8",
    });
    const parsed = manifestSchema.parse(JSON.parse(output));
    expect(parsed.artifacts).toHaveLength(1);
    expect(
      parsed.renders[0].qa
        .filter((check) => check.result === "passed")
        .map((check) => check.check),
    ).toEqual(["artifact", "container", "codecs", "duration", "mapping"]);
    expect(parsed.renders[0].cues[0].startMs).toBe(100);
    expect(parsed.events.at(-1)?.stage).toBe("local_bundle");
  }, 35000);
});
