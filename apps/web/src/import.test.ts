import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
afterEach(() => vi.unstubAllGlobals());
describe("explicit approved catalog import", () => {
  it("uses same-origin session and CSRF without supplying catalog IDs or credentials", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('{"imported":1}', { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await api.importApproved("fixture-csrf")).toEqual({ imported: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/import",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "fixture-csrf",
        },
      }),
    );
  });
  it("shows upstream validation failures without automatic retries", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: "Artifact verification failed" },
          }),
          { status: 422 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(api.importApproved("fixture")).rejects.toThrow(
      "Artifact verification failed",
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not claim a failed connection means the import was rolled back", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Connection lost"));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.importApproved("fixture")).rejects.toThrow(
      "Import could not be confirmed. Refresh the slate before retrying",
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("preserves useful reauthorization errors on a server failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              error: {
                message: "Private Drive access expired or was revoked.",
              },
            }),
            { status: 503 },
          ),
        ),
    );
    await expect(api.importApproved("fixture")).rejects.toThrow(
      "Private Drive access expired or was revoked.",
    );
  });
  it("propagates navigation cancellation to the request signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn().mockImplementation((_p, init) => {
      expect(init.signal.aborted).toBe(true);
      throw new DOMException("Cancelled", "AbortError");
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      api.importApproved("fixture", controller.signal),
    ).rejects.toThrow("Import could not be confirmed");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
