/** Links are recorded as provenance only. Validation never fetches or resolves them. */
export type IntakeProvider = "youtube" | "vimeo" | "drive" | "other";
export type IntakeUrlResult =
  | {
      ok: true;
      submittedUrl: string;
      canonicalUrl: string;
      provider: IntakeProvider;
    }
  | { ok: false; error: string };

function hasUnsafeUrlCharacters(value: string): boolean {
  return (
    /[\s\\]/u.test(value) ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  );
}

export function validateIntakeUrl(input: string): IntakeUrlResult {
  const submittedUrl = input.trim();
  const invalid = (
    error = "Use a public HTTP or HTTPS source link without credentials or a private network address.",
  ): IntakeUrlResult => ({ ok: false, error });
  if (
    !submittedUrl ||
    submittedUrl.length > 2048 ||
    hasUnsafeUrlCharacters(submittedUrl) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(submittedUrl)
  )
    return invalid();
  let url: URL;
  try {
    url = new URL(submittedUrl);
  } catch {
    return invalid();
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    return invalid();
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // All literal IP addresses are excluded, including normalized hexadecimal,
  // octal, integer IPv4 and bracketed/mapped IPv6. DNS is deliberately not used.
  if (
    !host.includes(".") ||
    host.includes(":") ||
    /^[\d.]+$/.test(host) ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host
      .split(".")
      .some(
        (label) => !label || label.startsWith("-") || label.endsWith("-"),
      ) ||
    /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|corp|lan|home|onion|arpa|test|invalid)$/.test(
      host,
    ) ||
    /(?:^|\.)(?:nip\.io|sslip\.io|localtest\.me|lvh\.me)$/.test(host)
  )
    return invalid();
  let canonicalUrl = submittedUrl;
  let provider: IntakeProvider = "other";
  // Normalize only recognized media providers. Arbitrary URL queries and
  // fragments can carry edition/range identity and must not be stripped.
  if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "www.youtu.be",
    ].includes(host)
  ) {
    const id = host.endsWith("youtu.be")
      ? url.pathname.split("/")[1]
      : url.pathname === "/watch"
        ? url.searchParams.get("v")
        : /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id))
      return invalid("Use a link to a specific YouTube video.");
    canonicalUrl = `https://www.youtube.com/watch?v=${id}`;
    provider = "youtube";
  } else if (
    ["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)
  ) {
    const match = /^\/(?:video\/)?(\d+)(?:\/([a-zA-Z0-9]+))?\/?$/.exec(
      url.pathname,
    );
    if (!match) return invalid("Use a link to a specific Vimeo video.");
    // Unlisted hashes control access; retain them in canonical identity.
    const hash = match[2] ?? url.searchParams.get("h");
    canonicalUrl = `https://vimeo.com/${match[1]}${hash ? `/${encodeURIComponent(hash)}` : ""}`;
    provider = "vimeo";
  } else if (host === "drive.google.com") {
    const id =
      /^\/file\/d\/([a-zA-Z0-9_-]+)(?:\/.*)?$/.exec(url.pathname)?.[1] ??
      (["/open", "/uc"].includes(url.pathname)
        ? url.searchParams.get("id")
        : null);
    if (!id || !/^[a-zA-Z0-9_-]{5,200}$/.test(id))
      return invalid(
        "Use a private Drive file link, rather than a folder link.",
      );
    canonicalUrl = `https://drive.google.com/file/d/${id}/view`;
    provider = "drive";
  }
  return { ok: true, submittedUrl, canonicalUrl, provider };
}

export function validateIntakeRange(
  inMs: number | null | undefined,
  outMs: number | null | undefined,
): string | null {
  if (inMs == null && outMs == null) return null;
  if (inMs == null || outMs == null)
    return "Enter both an in point and an out point, or leave both blank.";
  if (
    !Number.isSafeInteger(inMs) ||
    !Number.isSafeInteger(outMs) ||
    inMs < 0 ||
    outMs <= inMs ||
    outMs > 604_800_000
  )
    return "Use whole milliseconds with an out point after the in point, within seven days.";
  return null;
}

export interface ManualIntake {
  id: string;
  episodeId: string | null;
  kind: "already_cut" | "full_source";
  submittedUrl: string;
  canonicalUrl: string;
  provider: IntakeProvider;
  inMs: number | null;
  outMs: number | null;
  whyItMatters: string;
  status: "awaiting_processing" | "cancelled";
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface IntakeCreateInput {
  episodeId: string | null;
  kind: ManualIntake["kind"];
  url: string;
  inMs?: number | null;
  outMs?: number | null;
  whyItMatters?: string;
  allowDifferentRange?: boolean;
  expectedRevision: 0;
  idempotencyKey: string;
}
export interface IntakeUpdateInput {
  action: "update" | "cancel" | "restore";
  episodeId?: string | null;
  inMs?: number | null;
  outMs?: number | null;
  whyItMatters?: string;
  allowDifferentRange?: boolean;
  expectedRevision: number;
  idempotencyKey: string;
}
export interface IntakeList {
  version: number;
  items: ManualIntake[];
}
export interface IntakeMutationResult {
  intake: ManualIntake;
  intakeVersion: number;
}
export interface IntakeDuplicateMatch {
  kind: "intake" | "render";
  id: string;
  episodeId: string | null;
  rangeMatch: "exact" | "different";
}

/** Owner-configured upload destinations are Drive folders, never redirect links. */
export function safeUploadFolderUrl(
  value: string | null | undefined,
): string | null {
  if (!value || value !== value.trim() || hasUnsafeUrlCharacters(value))
    return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "drive.google.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/drive\/folders\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
