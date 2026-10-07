import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../apps/web/src/api";
afterEach(() => vi.unstubAllGlobals());
describe("Client uncertain-save reconciliation", () => {
  const input = {
    decision: "up" as const,
    note: "kept",
    expectedRevision: 0,
    idempotencyKey: "stable-request-key",
  };
  const saved = {
    decision: "up",
    revision: 1,
    note: "kept",
    reason: "",
    updatedAt: "2026-10-07T12:00:00Z",
  };
  it("reconciles dropped POST response using same operation key", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockResolvedValueOnce(Response.json(saved));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.review("exact-render", input, "csrf")).resolves.toEqual(
      saved,
    );
    expect(fetcher.mock.calls[1][0]).toBe("/api/operations/stable-request-key");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("reconciles server uncertain-save errors before retrying", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "SAVE_FAILED",
              message: "Save could not be confirmed",
            },
          },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json(saved));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.review("exact-render", input, "csrf")).resolves.toEqual(
      saved,
    );
    expect(fetcher.mock.calls[1][0]).toBe("/api/operations/stable-request-key");
  });
  it("does not reconcile a validation/authorization rejection as success", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Denied" } }, { status: 403 }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      api.review("exact-render", input, "csrf"),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
