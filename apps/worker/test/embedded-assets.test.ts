import { describe, expect, it, vi } from "vitest";
import { embeddedAssets } from "../src/embedded-assets";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import worker from "../src/index";
import type { Env } from "../src/env";
vi.mock("../src/auth", () => ({
  authenticate: vi.fn(async (r: Request) => {
    if (r.headers.get("X-Synthetic-Owner") !== "yes") {
      const { HttpError } = await import("../src/errors");
      throw new HttpError(
        401,
        "AUTH_REQUIRED",
        "Synthetic owner authentication required",
      );
    }
    return "synthetic-owner";
  }),
  isDemo: () => false,
  csrfToken: vi.fn(),
  guardMutation: vi.fn(),
}));
const map = {
  "/index.html": {
    body: "<html>synthetic café</html>",
    type: "text/html; charset=utf-8",
  },
  "/assets/app.js": {
    body: "console.log('synthetic')",
    type: "text/javascript; charset=utf-8",
  },
  "/assets/app.css": { body: "body{}", type: "text/css; charset=utf-8" },
  "/demo/one.svg": { body: "<svg/>", type: "image/svg+xml" },
};
const assets = embeddedAssets(map);
describe("legacy embedded frontend routing", () => {
  it.each([
    "/",
    "/index.html",
    "/review/episode",
    "/assets/app.js",
    "/assets/app.css",
    "/demo/one.svg",
  ])("preserves %s content/type/HEAD", async (path) => {
    const get = await assets.fetch(new Request("https://example.com" + path));
    const head = await assets.fetch(
      new Request("https://example.com" + path, { method: "HEAD" }),
    );
    const key = Object.hasOwn(map, path)
      ? (path as keyof typeof map)
      : "/index.html";
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(map[key].body);
    expect(get.headers.get("Content-Type")).toBe(map[key].type);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("Content-Type")).toBe(map[key].type);
  });
  it.each([
    "/api/nope",
    "/media/nope",
    "/assets/missing.js",
    "/demo/missing",
    "/missing.txt",
    "/encoded%2fpath",
  ])("does not widen fallback for %s", async (path) =>
    expect(
      (await assets.fetch(new Request("https://example.com" + path))).status,
    ).toBe(404),
  );
  it("rejects writes", async () =>
    expect(
      (
        await assets.fetch(
          new Request("https://example.com/", { method: "POST" }),
        )
      ).status,
    ).toBe(405));
  it("does not bypass owner auth; keeps response security/cache policy", async () => {
    const db = { prepare: vi.fn(), batch: vi.fn() };
    const env = {
      DB: db,
      APP_ENV: "production",
      ASSETS: assets,
    } as unknown as Env;
    expect(
      (await worker.fetch(new Request("https://example.com/"), env)).status,
    ).toBe(401);
    const response = await worker.fetch(
      new Request("https://example.com/", {
        headers: { "X-Synthetic-Owner": "yes" },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(map["/index.html"].body);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, no-transform",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(
      (
        await worker.fetch(
          new Request(
            "https://example.com/api/v2/number-one/inventory-snapshots",
            { method: "POST" },
          ),
          env,
        )
      ).status,
    ).toBe(503);
    expect(db.prepare).not.toHaveBeenCalled();
  });
  it("packages byte-identical receiver/assets and preserves scheduled/export delegation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twib-embedded-"));
    try {
      const backend =
        'export default { scheduled(){return "schedule"}, async fetch(req,env,ctx){ if(req.headers.get("X-Synthetic-Owner")!=="yes")return new Response("denied",{status:401}); return env.ASSETS.fetch(req); }};';
      writeFileSync(join(dir, "backend.mjs"), backend);
      writeFileSync(join(dir, "assets.json"), JSON.stringify(map));
      execFileSync(process.execPath, [
        resolve("scripts/build-embedded-worker.mjs"),
        join(dir, "backend.mjs"),
        join(dir, "assets.json"),
        join(dir, "out"),
      ]);
      expect(readFileSync(join(dir, "out/receiver.mjs"), "utf8")).toBe(backend);
      const hashes = JSON.parse(
        readFileSync(join(dir, "out/asset-hashes.json"), "utf8"),
      );
      for (const [path, value] of Object.entries(map))
        expect(hashes.find((x: { path: string }) => x.path === path)).toEqual({
          path,
          type: value.type,
          bytes: Buffer.byteLength(value.body),
          sha256: createHash("sha256").update(value.body).digest("hex"),
        });
      const packaged = (
        await import(
          /* @vite-ignore */ pathToFileURL(join(dir, "out/worker.mjs")).href
        )
      ).default;
      expect(packaged.scheduled()).toBe("schedule");
      expect(
        (await packaged.fetch(new Request("https://example.com/"), {}, {}))
          .status,
      ).toBe(401);
      const response = await packaged.fetch(
        new Request("https://example.com/", {
          headers: { "X-Synthetic-Owner": "yes" },
        }),
        {},
        {},
      );
      expect(await response.text()).toBe(map["/index.html"].body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
