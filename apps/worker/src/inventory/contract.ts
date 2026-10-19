import { containsRecognizableSecret } from "./secrets";
/* eslint-disable no-control-regex -- Explicitly reject control bytes in untrusted metadata. */
import {
  validateManifest as validateSchema,
  validateEnvelope as validateEnvelopeSchema,
} from "./validator.generated.js";
import { HttpError } from "../errors";
import type { InventoryProducerRecord } from "@twib/shared";

export const INVENTORY_SOURCE = "nomad:number-one";
// Deliberately smaller than the proposal: one D1 row must remain below 2,000,000 bytes.
export const INVENTORY_MAX_BYTES = 1024 * 1024;
export const INVENTORY_MAX_ITEMS = 2000;
export interface InventoryItem {
  producer_record?: InventoryProducerRecord;
  id: string;
  kind: "candidate" | "media";
  media: null | {
    ref: string;
    present: boolean;
    size_bytes: number | null;
    modified_at: string | null;
    duration_seconds: number | null;
  };
  observations: {
    artifact: string | null;
    status: string;
    context: Record<string, string>;
    timestamps: Record<string, string>;
  }[];
  origins: { id: string; url: string }[];
  processing_status: string;
  ready: false;
  capture_evidence?: {
    artifact: string | null;
    matches_observed_size: boolean;
    content_hash_verified: false;
    streams_reprobed: false;
    producer_sha256?: string;
  }[];
}
export interface InventoryManifest {
  schema: "number-one-twib-inventory/v1";
  source_id: string;
  episode: { id: string; show: "twib"; number: number };
  snapshot: {
    mode: "full";
    complete: boolean;
    allow_deletions: false;
    scope: string;
    consistency: string;
    candidate_coverage: "partial";
  };
  coverage: { artifact: string | null; status: string }[];
  items: InventoryItem[];
  warnings: string[];
  idempotency_digest: string;
  observed_at: string;
  scan_finished_at: string;
}
// Internal contract, NOT an authentication mechanism or client-supplied claims.
// The dedicated machine-auth adapter constructs this server-side.
export interface InventoryGrant {
  sourceId: string;
  episodeId: string;
  episodeNumber: number;
  expiresAt: number;
  scope: "inventory:write";
  allowEditorialContext: boolean;
  nativeIntakeContext?: boolean;
  originHosts: readonly string[];
}
const invalid = (code = "INVENTORY_INVALID") =>
  new HttpError(
    422,
    code,
    "Inventory failed validation; no metadata was stored.",
  );
export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function inventoryEpisodeId(number: number): Promise<string> {
  return (
    "episode_" +
    (await sha256(JSON.stringify([INVENTORY_SOURCE, "twib", number])))
  );
}
// Server-local equality only, never presented as Python's client digest algorithm.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => JSON.stringify(key) + ":" + canonical(child))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function semanticHash(
  manifest: InventoryManifest,
): Promise<string> {
  const payload = { ...manifest } as Partial<InventoryManifest>;
  delete payload.observed_at;
  delete payload.scan_finished_at;
  delete payload.idempotency_digest;
  return sha256(canonical(payload));
}
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalid("INVENTORY_UNSAFE_REFERENCE");
  }
}
function safeRef(value: string | null): void {
  if (value === null) return;
  if (value.length > 1024) throw invalid("INVENTORY_UNSAFE_REFERENCE");
  // Refs are literal filesystem names, not transport-encoded paths. Decoding is
  // inspection only: never return/rewrite the producer's identity or reference.
  const separators = value.split("/").length;
  let view = value;
  for (let pass = 0; pass <= 6; pass++) {
    if (
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(view) ||
      /[\\?#:]/.test(view) ||
      view.startsWith("/") ||
      view.split("/").length !== separators ||
      view.split("/").some((part) => !part || part === "." || part === "..") ||
      containsRecognizableSecret(view)
    )
      throw invalid("INVENTORY_UNSAFE_REFERENCE");
    if (!/%[a-f0-9]{2}/i.test(view)) return;
    if (pass === 6) throw invalid("INVENTORY_UNSAFE_REFERENCE");
    try {
      // Protect malformed/bare percent signs as literal data, while still
      // checking valid escapes in mixed strings such as token%3Dx%zz.mp4.
      view = decodeURIComponent(view.replace(/%(?![a-f0-9]{2})/gi, "%25"));
    } catch {
      throw invalid("INVENTORY_UNSAFE_REFERENCE");
    }
  }
}
function publicUrl(value: string, grant: InventoryGrant): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("INVENTORY_UNSAFE_URL");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const path = decoded(url.pathname);
  const youtubeQuery =
    host === "www.youtube.com" &&
    url.pathname === "/watch" &&
    /^\?v=[a-zA-Z0-9_-]{11}$/.test(url.search);
  if (
    value.length > 2048 ||
    /[\u0000-\u0020\u007f\\]/.test(value) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    (url.search && !youtubeQuery) ||
    host !== url.hostname ||
    !host.includes(".") ||
    /^[0-9.]+$/.test(host) ||
    host.includes(":") ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
    !grant.originHosts.includes(host) ||
    containsRecognizableSecret(path) ||
    /[\u0000-\u001f\u007f]/.test(path)
  )
    throw invalid("INVENTORY_UNSAFE_URL");
}
function prose(value: string, grant: InventoryGrant): void {
  if (!grant.allowEditorialContext)
    throw invalid("INVENTORY_PRIVACY_REVIEW_REQUIRED");
  if (
    value.length > 4000 ||
    controls.test(value) ||
    containsRecognizableSecret(value)
  )
    throw invalid("INVENTORY_PRIVACY_REJECTED");
  const withoutUrls = value.replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
    publicUrl(url, grant);
    return "";
  });
  if (/(?<![\w:])\/(?:[^\s<>"']+)|[a-zA-Z]:[\\/]|\\\\/.test(withoutUrls))
    throw invalid("INVENTORY_PRIVACY_REJECTED");
}
function bounded(value: unknown, depth = 0): void {
  if (depth > 16) throw invalid();
  if (
    typeof value === "string" &&
    (value.length > 4000 || controls.test(value))
  )
    throw invalid();
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  )
    throw invalid();
  if (Array.isArray(value)) {
    if (value.length > INVENTORY_MAX_ITEMS) throw invalid("INVENTORY_LIMIT");
    for (const child of value) bounded(child, depth + 1);
  } else if (value && typeof value === "object")
    for (const child of Object.values(value)) bounded(child, depth + 1);
}
export async function validateInventory(
  value: unknown,
  key: string | null,
  grant: InventoryGrant | null,
  now = Date.now(),
): Promise<InventoryManifest> {
  if (
    !grant ||
    grant.scope !== "inventory:write" ||
    grant.sourceId !== INVENTORY_SOURCE ||
    !Number.isFinite(grant.expiresAt) ||
    grant.expiresAt <= now
  )
    throw new HttpError(
      403,
      "INVENTORY_SCOPE_DENIED",
      "A current source-and-episode inventory grant is required.",
    );
  bounded(value);
  if (!validateSchema(value)) throw invalid();
  const manifest = value as InventoryManifest;
  if (
    new TextEncoder().encode(JSON.stringify(manifest)).byteLength >
    INVENTORY_MAX_BYTES
  )
    throw new HttpError(
      413,
      "INVENTORY_LIMIT",
      "Inventory exceeds the receiver limit.",
    );
  if (
    manifest.episode.id !== grant.episodeId ||
    manifest.episode.number !== grant.episodeNumber ||
    manifest.source_id !== grant.sourceId ||
    manifest.episode.id !== (await inventoryEpisodeId(manifest.episode.number))
  )
    throw new HttpError(
      403,
      "INVENTORY_SCOPE_DENIED",
      "Inventory does not match the authorized episode.",
    );
  if (key !== manifest.idempotency_digest)
    throw invalid("INVENTORY_KEY_MISMATCH");
  const start = Date.parse(manifest.observed_at),
    finish = Date.parse(manifest.scan_finished_at);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(finish) ||
    start > finish ||
    finish > now + 300000
  )
    throw invalid("INVENTORY_TIME_INVALID");
  if (manifest.coverage.length > 2000 || manifest.warnings.length > 2000)
    throw invalid("INVENTORY_LIMIT");
  for (const warning of manifest.warnings)
    if (!/^[a-z_]+(?::[a-f0-9]{16})?$/.test(warning))
      throw invalid("INVENTORY_PRIVACY_REJECTED");
  for (const row of manifest.coverage) safeRef(row.artifact);
  // Capability is server-derived, never a request field. The marker only selects a
  // stricter native subset contract; it does not prove local Pinboard provenance.
  const nativeContext =
    grant.nativeIntakeContext === true &&
    grant.episodeNumber === 128 &&
    now >= Date.parse("2026-10-19T17:54:33.000Z") &&
    now < Date.parse("2026-10-26T15:08:09.000Z") &&
    manifest.warnings.includes("native_pinboard_subset");
  if (
    nativeContext &&
    (manifest.snapshot.complete ||
      manifest.snapshot.allow_deletions ||
      manifest.coverage.length ||
      manifest.items.some(
        (item) =>
          item.kind !== "media" ||
          !item.media?.present ||
          !item.producer_record?.clip_id ||
          item.producer_record.record_kind !== "processing-history" ||
          item.producer_record.parent_clip_id != null ||
          item.producer_record.manual_derivative != null ||
          !["captured_observed", "unverified"].includes(
            item.processing_status,
          ) ||
          item.observations.some(
            (observation) =>
              Object.keys(observation.timestamps).length > 0 ||
              Object.keys(observation).some(
                (key) =>
                  !["artifact", "status", "context", "timestamps"].includes(
                    key,
                  ),
              ),
          ),
      ))
  )
    throw invalid("INVENTORY_NATIVE_INTAKE_SHAPE");
  const contentGrant: InventoryGrant = nativeContext
    ? {
        ...grant,
        allowEditorialContext: true,
        originHosts: [
          "youtu.be",
          "youtube.com",
          "www.youtube.com",
          "m.youtube.com",
          "x.com",
          "www.x.com",
          "twitter.com",
          "www.twitter.com",
        ],
      }
    : grant;
  const ids = new Set<string>();
  for (const item of manifest.items) {
    if (
      item.producer_record &&
      (item.kind !== "media" ||
        containsRecognizableSecret(JSON.stringify(item.producer_record)))
    )
      throw invalid("INVENTORY_PRIVACY_REJECTED");
    const manual = item.producer_record?.manual_derivative;
    if (
      manual &&
      (manual.parent_clip_id !== item.producer_record?.parent_clip_id ||
        manual.parent_clip_id === item.producer_record?.clip_id ||
        manual.parent_clip_id === item.producer_record?.clip_uid ||
        manual.source_out_seconds <= manual.source_in_seconds ||
        manual.source_out_seconds > manual.source_duration_seconds ||
        item.capture_evidence?.some(
          (e) =>
            e.producer_sha256 && e.producer_sha256 !== manual.derivative_sha256,
        ))
    )
      throw invalid("INVENTORY_MANUAL_DERIVATIVE_INVALID");
    if (ids.has(item.id)) throw invalid("INVENTORY_DUPLICATE_ITEM");
    ids.add(item.id);
    if (new TextEncoder().encode(JSON.stringify(item)).byteLength > 32768)
      throw invalid("INVENTORY_LIMIT");
    if (
      item.observations.length > 100 ||
      item.origins.length > 100 ||
      (item.capture_evidence?.length ?? 0) > 100
    )
      throw invalid("INVENTORY_LIMIT");
    safeRef(item.media?.ref ?? null);
    if (
      item.kind === "candidate" &&
      !["candidate", "capture_required", "failed"].includes(
        item.processing_status,
      )
    )
      throw invalid();
    if (
      item.kind === "media" &&
      ![
        "captured_observed",
        "unverified",
        "incomplete",
        "missing",
        "quarantined",
      ].includes(item.processing_status)
    )
      throw invalid();
    if (
      item.processing_status === "captured_observed" &&
      (!item.media?.present ||
        !item.media.size_bytes ||
        !item.capture_evidence?.some(
          (e) => e.matches_observed_size && e.producer_sha256,
        ))
    )
      throw invalid();
    if (
      item.media &&
      (item.processing_status === "missing") === item.media.present
    )
      throw invalid();
    for (const observation of item.observations) {
      safeRef(observation.artifact);
      if (
        nativeContext &&
        Object.keys(observation.context).some(
          (key) => !["title", "operator_note", "extended"].includes(key),
        )
      )
        throw invalid("INVENTORY_NATIVE_INTAKE_CONTEXT");
      for (const text of Object.values(observation.context))
        prose(text, contentGrant);
    }
    for (const origin of item.origins) publicUrl(origin.url, contentGrant);
    for (const evidence of item.capture_evidence ?? [])
      safeRef(evidence.artifact);
  }
  return manifest;
}
export async function readInventoryBody(request: Request): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("Content-Type") ?? "",
    ) ||
    request.headers.has("Content-Encoding")
  )
    throw new HttpError(
      415,
      "INVENTORY_JSON_REQUIRED",
      "Use uncompressed JSON.",
    );
  if (Number(request.headers.get("Content-Length")) > INVENTORY_MAX_BYTES)
    throw new HttpError(
      413,
      "INVENTORY_LIMIT",
      "Inventory exceeds the receiver limit.",
    );
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > INVENTORY_MAX_BYTES) {
          await reader.cancel();
          throw new HttpError(
            413,
            "INVENTORY_LIMIT",
            "Inventory exceeds the receiver limit.",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "INVENTORY_JSON_INVALID", "Invalid JSON.");
  }
}

export interface InventoryEnvelope {
  schema: "number-one-inventory-envelope/v2";
  scan_id: string;
  sequence: number;
  manifest: InventoryManifest;
}
export async function envelopeHash(
  envelope: InventoryEnvelope,
): Promise<string> {
  return sha256(canonical(envelope));
}
export async function validateEnvelope(
  input: unknown,
  key: string | null,
  grant: InventoryGrant | null,
  now = Date.now(),
): Promise<InventoryEnvelope> {
  bounded(input);
  if (!validateEnvelopeSchema(input))
    throw invalid("INVENTORY_ENVELOPE_INVALID");
  const value = input as InventoryEnvelope;
  if (key !== value.scan_id) throw invalid("INVENTORY_KEY_MISMATCH");
  const manifest = await validateInventory(
    value.manifest,
    (value.manifest as Partial<InventoryManifest> | null)?.idempotency_digest ??
      null,
    grant,
    now,
  );
  const envelope: InventoryEnvelope = {
    schema: "number-one-inventory-envelope/v2",
    scan_id: value.scan_id,
    sequence: value.sequence as number,
    manifest,
  };
  if (
    new TextEncoder().encode(JSON.stringify(envelope)).byteLength >
    INVENTORY_MAX_BYTES
  )
    throw new HttpError(
      413,
      "INVENTORY_LIMIT",
      "Inventory exceeds the receiver limit.",
    );
  return envelope;
}
