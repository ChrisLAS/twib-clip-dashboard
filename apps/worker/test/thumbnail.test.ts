import { describe, expect, it, vi } from "vitest";
import { media } from "../src/media";
import type { Env } from "../src/env";

const link = "https://lh3.googleusercontent.com/drive-storage/fixture=s220";
const info = {
  size: "10",
  mimeType: "video/mp4",
  sha256Checksum: "fixture-hash",
  capabilities: { canDownload: true },
  thumbnailLink: link,
};
function setup(
  metadata = info,
  image = () =>
    new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": "3",
        "Set-Cookie": "do-not-forward",
        Location: link,
      },
    }),
) {
  const bind = vi.fn().mockReturnValue({
    first: async () => ({
      file_id: "approved-fixture",
      size: 10,
      sha256: "fixture-hash",
      mime: "video/mp4",
    }),
  });
  const env = {
    GOOGLE_CLIENT_ID: "fixture",
    GOOGLE_CLIENT_SECRET: "fixture",
    GOOGLE_REFRESH_TOKEN: "fixture",
    DB: { prepare: () => ({ bind }) },
  } as unknown as Env;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com"))
      return Response.json({ access_token: "fixture-access-token" });
    if (url.includes("www.googleapis.com")) return Response.json(metadata);
    return image();
  });
  const run = (method = "GET") =>
    media(
      new Request("https://review.example/media/render-fixture/thumbnail", {
        method,
      }),
      env,
      "render-fixture",
      "thumbnail",
      fetcher as typeof fetch,
    );
  return { run, fetcher, bind };
}
describe("Private verified video thumbnails", () => {
  it("resolves the original and proxies image bytes without fetching the MP4 or leaking upstream headers", async () => {
    const { run, bind, fetcher } = setup();
    const response = await run();
    expect(bind).toHaveBeenCalledWith("render-fixture", "original");
    expect(response.status).toBe(200);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      1, 2, 3,
    ]);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toContain(
      "private, no-store",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Location")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls
        .map(([url]) => String(url))
        .some((url) => url.includes("alt=media")),
    ).toBe(false);
    expect(fetcher).toHaveBeenLastCalledWith(
      link,
      expect.objectContaining({
        redirect: "manual",
        headers: { Authorization: "Bearer fixture-access-token" },
      }),
    );
  });
  it("HEAD validates metadata and image headers without returning an image body", async () => {
    const { run, fetcher } = setup();
    const response = await run("HEAD");
    expect(response.body).toBeNull();
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(fetcher).toHaveBeenLastCalledWith(
      link,
      expect.objectContaining({ method: "HEAD" }),
    );
  });
  it.each([
    { ...info, sha256Checksum: "changed" },
    { ...info, size: "11" },
    { ...info, mimeType: "text/html" },
  ])("fails closed when original metadata changes", async (metadata) => {
    const { run, fetcher } = setup(metadata);
    await expect(run()).rejects.toMatchObject({
      status: 409,
      code: "ARTIFACT_CHANGED",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("enforces original download permission", async () => {
    const { run, fetcher } = setup({
      ...info,
      capabilities: { canDownload: false },
    });
    await expect(run()).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("returns an explicit unavailable result for absent thumbnail metadata", async () => {
    const { run } = setup({ ...info, thumbnailLink: "" });
    await expect(run()).rejects.toMatchObject({
      status: 404,
      code: "THUMBNAIL_UNAVAILABLE",
    });
  });
  it.each([
    "http://lh3.googleusercontent.com/image",
    "https://lh3.googleusercontent.com.evil.example/image",
    "https://evil.example/image",
    "https://127.0.0.1/image",
    "https://lh3.googleusercontent.com:444/image",
    "https://user:pass@lh3.googleusercontent.com/image",
    "not-a-url",
    "https://lh3.googleusercontent.com/image#fragment",
  ])(
    "rejects unsafe thumbnail URL %s before sending credentials",
    async (thumbnailLink) => {
      const { run, fetcher } = setup({ ...info, thumbnailLink });
      await expect(run()).rejects.toMatchObject({ status: 502 });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it("does not follow redirects", async () => {
    const { run, fetcher } = setup(
      info,
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example" },
        }),
    );
    await expect(run()).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each(["text/html", "image/svg+xml", "video/mp4"])(
    "rejects non-raster MIME %s",
    async (mime) => {
      const { run } = setup(
        info,
        () => new Response("bad", { headers: { "Content-Type": mime } }),
      );
      await expect(run()).rejects.toMatchObject({ status: 502 });
    },
  );
  it.each(["2097153", "garbage", "0", "-1", "4"])(
    "rejects invalid or mismatched declared image length %s",
    async (length) => {
      const { run } = setup(
        info,
        () =>
          new Response(new Uint8Array(3), {
            headers: { "Content-Type": "image/png", "Content-Length": length },
          }),
      );
      await expect(run()).rejects.toMatchObject({ status: 502 });
    },
  );
  it("bounds chunked images without trusting Content-Length", async () => {
    const cancel = vi.fn();
    const { run } = setup(
      info,
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel,
          }),
          { headers: { "Content-Type": "image/jpeg" } },
        ),
    );
    await expect(run()).rejects.toMatchObject({ status: 502 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("supports bounded chunked image responses", async () => {
    const { run } = setup(
      info,
      () =>
        new Response(new Uint8Array([1, 2]), {
          headers: { "Content-Type": "image/webp" },
        }),
    );
    const response = await run();
    expect(response.headers.get("Content-Length")).toBe("2");
  });
});
