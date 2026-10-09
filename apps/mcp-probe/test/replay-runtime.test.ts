import { afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let runtime: Miniflare | undefined;
afterAll(async () => {
  await runtime?.dispose();
});
it("atomically rejects concurrent replay in real workerd Durable Object storage", async () => {
  const source = fileURLToPath(new URL("../src/replay.ts", import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `import { ReplayGuard } from ${JSON.stringify(source)}; export { ReplayGuard }; export default { async fetch(request, env) { const guard = env.REPLAY_GUARD.getByName('test-marker'); const key = 'a'.repeat(64); if (new URL(request.url).pathname === '/revoked') return Response.json(await guard.revoked()); return Response.json(await guard.claim(key)); } };`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "replay-test",
          modules: true,
          script: bundle.outputFiles[0].text,
          compatibilityDate: "2026-10-01",
          durableObjects: {
            REPLAY_GUARD: { className: "ReplayGuard", useSQLite: true },
          },
        },
      ],
    }),
  );
  const results = await Promise.all(
    Array.from({ length: 8 }, async () =>
      (await runtime!.dispatchFetch("https://local.test/claim")).json(),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(
    await (await runtime.dispatchFetch("https://local.test/revoked")).json(),
  ).toBe(true);
}, 30_000);
