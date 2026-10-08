import type { Env } from "./env";
import { HttpError } from "./errors";
import { googleToken, upstreamError } from "./google";
import { thumbnail } from "./thumbnail";
export function parseRange(
  value: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!value) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2]))
    throw new HttpError(
      416,
      "RANGE_INVALID",
      "Only one valid byte range is supported.",
    );
  let start: number, end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw new HttpError(416, "RANGE_INVALID", "Invalid suffix range.");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new HttpError(
      416,
      "RANGE_INVALID",
      "Range is outside this artifact.",
    );
  return { start, end };
}
interface Artifact {
  file_id: string;
  size: number;
  sha256: string;
  mime: string;
}
export async function media(
  request: Request,
  env: Env,
  id: string,
  kind: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const artifact = await env.DB.prepare(
    "SELECT * FROM artifacts WHERE render_id=? AND kind=?",
  )
    .bind(id, kind === "thumbnail" ? "original" : kind)
    .first<Artifact>();
  if (!artifact)
    throw new HttpError(
      404,
      "MEDIA_UNAVAILABLE",
      "No private media is configured for this render.",
    );
  const token = await googleToken(env, fetcher);
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(artifact.file_id)}`;
  const meta = await fetcher(
    `${base}?fields=size,mimeType,capabilities(canDownload),sha256Checksum${kind === "thumbnail" ? ",thumbnailLink" : ""}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: request.signal },
  );
  if (!meta.ok) throw upstreamError(meta.status);
  const info = (await meta.json()) as {
    size: string;
    mimeType: string;
    capabilities?: { canDownload?: boolean };
    sha256Checksum?: string;
    thumbnailLink?: string;
  };
  if (!info.capabilities?.canDownload)
    throw new HttpError(
      403,
      "DOWNLOAD_FORBIDDEN",
      "The owner cannot download this artifact.",
    );
  if (
    Number(info.size) !== artifact.size ||
    info.mimeType !== artifact.mime ||
    info.sha256Checksum !== artifact.sha256
  )
    throw new HttpError(
      409,
      "ARTIFACT_CHANGED",
      "The Drive file no longer matches this immutable render. Re-import a new render.",
    );
  if (kind === "thumbnail")
    return thumbnail(request, info.thumbnailLink, token, fetcher);
  const etag = `"${artifact.sha256}"`;
  const headers = new Headers({
    "Content-Type": artifact.mime,
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Cache-Control": "private, no-store, no-transform",
    "X-Content-Type-Options": "nosniff",
  });
  if (new URL(request.url).searchParams.get("download") === "1")
    headers.set(
      "Content-Disposition",
      `attachment; filename="${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp4"`,
    );
  let range;
  try {
    range = parseRange(
      request.headers.has("If-Range") &&
        request.headers.get("If-Range") !== etag
        ? null
        : request.headers.get("Range"),
      artifact.size,
    );
  } catch (e) {
    if (e instanceof HttpError && e.status === 416) {
      headers.set("Content-Range", `bytes */${artifact.size}`);
      return new Response(null, { status: 416, headers });
    }
    throw e;
  }
  const length = range ? range.end - range.start + 1 : artifact.size;
  headers.set("Content-Length", String(length));
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${artifact.size}`,
    );
  if (request.method === "HEAD")
    return new Response(null, { status: range ? 206 : 200, headers });
  const upstream = await fetcher(`${base}?alt=media`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    },
    signal: request.signal,
  });
  if (!upstream.ok) throw upstreamError(upstream.status);
  if (
    upstream.status !== (range ? 206 : 200) ||
    !upstream.headers.get("Content-Type")?.startsWith("video/") ||
    Number(upstream.headers.get("Content-Length")) !== length ||
    (range &&
      upstream.headers.get("Content-Range") !== headers.get("Content-Range"))
  ) {
    await upstream.body?.cancel();
    throw new HttpError(
      502,
      "INVALID_MEDIA_RESPONSE",
      "Drive returned unexpected media bytes.",
    );
  }
  return new Response(upstream.body, { status: range ? 206 : 200, headers });
}
