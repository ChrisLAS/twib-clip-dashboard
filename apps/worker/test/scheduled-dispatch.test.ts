import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
const mocks = vi.hoisted(() => ({ publication: vi.fn(), catalog: vi.fn() }));
vi.mock("../src/publication", () => ({
  syncPublication: mocks.publication,
  publicationConfigured: (env: Env) =>
    !!env.PUBLICATION_FEED_URL && !!env.PUBLICATION_ALLOWED_HOSTS,
}));
vi.mock("../src/importer", () => ({ pullManifest: mocks.catalog }));
import worker from "../src/index";
beforeEach(() => {
  mocks.publication.mockReset().mockResolvedValue({});
  mocks.catalog.mockReset().mockResolvedValue({});
});
function invoke(cron: string, configured = true) {
  const waitUntil = vi.fn();
  worker.scheduled(
    { cron, scheduledTime: Date.now(), noRetry() {} },
    {
      APP_ENV: "production",
      ...(configured
        ? {
            PUBLICATION_FEED_URL: "https://example.com/feed",
            PUBLICATION_ALLOWED_HOSTS: "example.com",
          }
        : {}),
    } as Env,
    { waitUntil } as unknown as ExecutionContext,
  );
  return waitUntil;
}
describe("separate scheduled invocation CPU budgets", () => {
  it("five-minute catalog never starts RSS work", async () => {
    const wait = invoke("*/5 * * * *");
    expect(wait).toHaveBeenCalledTimes(1);
    await wait.mock.calls[0][0];
    expect(mocks.catalog).toHaveBeenCalledOnce();
    expect(mocks.publication).not.toHaveBeenCalled();
  });
  it("offset hourly publication never starts catalog work", async () => {
    const wait = invoke("2 * * * *");
    expect(wait).toHaveBeenCalledTimes(1);
    await wait.mock.calls[0][0];
    expect(mocks.publication).toHaveBeenCalledOnce();
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it("unknown schedules fail visibly without either job", () => {
    expect(() => invoke("* * * * *")).toThrow(/Unrecognized/);
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.publication).not.toHaveBeenCalled();
  });
  it("unconfigured hourly adapter is an honest no-op", () => {
    expect(invoke("2 * * * *", false)).not.toHaveBeenCalled();
    expect(mocks.publication).not.toHaveBeenCalled();
  });
});
