import { HttpError } from "./errors";
import { upstreamError } from "./google";

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const RASTER_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);
function invalidThumbnail(): HttpError {
  return new HttpError(
    502,
    "INVALID_THUMBNAIL_RESPONSE",
    "Drive returned an unsupported preview image.",
  );
}

// Only called after the original artifact's immutable metadata and permissions
// are verified. Never persist or expose Drive's temporary thumbnail URL.
export async function thumbnail(
  request: Request,
  link: string | undefined,
  token: string,
  fetcher: typeof fetch,
): Promise<Response> {
  if (!link)
    throw new HttpError(
      404,
      "THUMBNAIL_UNAVAILABLE",
      "A preview image is not available for this render.",
    );
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw invalidThumbnail();
  }
  // Drive serves video thumbnails on Google's dedicated image hosts. Keep
  // credentials off arbitrary URLs and never follow even same-host redirects.
  if (
    url.protocol !== "https:" ||
    !/^lh[3-6]\.googleusercontent\.com$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw invalidThumbnail();
  const upstream = await fetcher(url.toString(), {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: request.signal,
  });
  if (upstream.status !== 200) {
    await upstream.body?.cancel();
    if (upstream.status >= 300 && upstream.status < 400)
      throw invalidThumbnail();
    throw upstreamError(upstream.status);
  }
  const mime = upstream.headers
    .get("Content-Type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  const declared = upstream.headers.get("Content-Length");
  if (
    !mime ||
    !RASTER_TYPES.has(mime) ||
    (declared !== null &&
      (!/^\d+$/.test(declared) ||
        Number(declared) <= 0 ||
        Number(declared) > MAX_THUMBNAIL_BYTES))
  ) {
    await upstream.body?.cancel();
    throw invalidThumbnail();
  }
  const headers = new Headers({
    "Content-Type": mime,
    "Cache-Control": "private, no-store, no-transform",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    await upstream.body?.cancel();
    if (declared !== null) headers.set("Content-Length", declared);
    return new Response(null, { headers });
  }
  if (!upstream.body) throw invalidThumbnail();
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_THUMBNAIL_BYTES) {
        await reader.cancel();
        throw invalidThumbnail();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size || (declared !== null && Number(declared) !== size))
    throw invalidThumbnail();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  headers.set("Content-Length", String(size));
  return new Response(bytes, { headers });
}
