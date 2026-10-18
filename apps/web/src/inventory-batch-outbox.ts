import { z } from "zod";
import type { InventoryReviewInput } from "@twib/shared";

const spec = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("first_pass"),
      guidance: z.string().min(1).max(2000).optional(),
      startSeconds: z.number().finite().min(0).max(86400).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("range"),
      startSeconds: z.number().finite().min(0).max(86400),
      endSeconds: z.number().finite().positive().max(86400),
    })
    .strict()
    .refine(
      (v) =>
        v.endSeconds > v.startSeconds && v.endSeconds - v.startSeconds <= 180,
    ),
]);
const payloadSchema = z
  .object({
    operationId: z.string().uuid(),
    episodeNumber: z.number().int().min(1).max(999999),
    itemId: z.string().regex(/^item_[a-f0-9]{64}$/),
    expectedRevision: z.number().int().nonnegative(),
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.literal("decision"),
    status: z.literal("cut_down"),
    notes: z.string().max(4000),
    reason: z.string().max(2000),
    cutSpec: spec,
  })
  .strict();
const schema = z
  .object({
    schema: z.literal(1),
    owner: z.string().min(1),
    source: z.string().min(1),
    episode: z.string().min(1),
    entries: z
      .array(
        z
          .object({
            payload: payloadSchema,
            status: z.enum(["pending", "saved", "rejected"]),
            // Missing in older v1 outboxes: conservatively treat as attempted.
            attempted: z.boolean().optional(),
            receipt: z
              .object({
                state: z.string().max(100),
                code: z.string().max(100).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.entries.map((e) => e.payload.itemId)).size ===
        v.entries.length &&
      new Set(v.entries.map((e) => e.payload.operationId)).size ===
        v.entries.length,
  );
export type BatchOutbox = z.infer<typeof schema>;
export type BatchScope = Pick<BatchOutbox, "owner" | "source" | "episode"> & {
  episodeNumber: number;
};
export function outboxKey(scope: BatchScope) {
  return (
    "twib.batch-outbox.v1:" +
    JSON.stringify([scope.owner, scope.source, scope.episode])
  );
}
export function readOutbox(
  storage: Storage,
  scope: BatchScope,
): BatchOutbox | null {
  if (!scope.owner || !scope.source || !scope.episode)
    throw new Error(
      "An authenticated owner and exact inventory scope are required.",
    );
  const raw = storage.getItem(outboxKey(scope));
  if (raw === null) return null;
  if (raw.length > 250000)
    throw new Error("Stored batch is too large; submission is blocked.");
  const box = schema.parse(JSON.parse(raw));
  if (
    box.owner !== scope.owner ||
    box.source !== scope.source ||
    box.episode !== scope.episode ||
    box.entries.some(
      (entry) => entry.payload.episodeNumber !== scope.episodeNumber,
    )
  )
    throw new Error("Stored batch owner or inventory scope does not match.");
  return box;
}
export function writeOutbox(
  storage: Storage,
  scope: BatchScope,
  box: BatchOutbox,
) {
  const value = schema.parse(box);
  if (
    value.owner !== scope.owner ||
    value.source !== scope.source ||
    value.episode !== scope.episode ||
    value.entries.some(
      (entry) => entry.payload.episodeNumber !== scope.episodeNumber,
    )
  )
    throw new Error("Cannot persist a batch for another owner or scope.");
  const prior = readOutbox(storage, scope);
  if (
    prior &&
    (JSON.stringify(prior.entries.map((e) => e.payload)) !==
      JSON.stringify(value.entries.map((e) => e.payload)) ||
      prior.entries.some(
        (e, i) =>
          (e.status !== "pending" && e.status !== value.entries[i]?.status) ||
          (e.attempted !== false && value.entries[i]?.attempted === false),
      ))
  )
    throw new Error(
      "Stored operation payloads and confirmed outcomes are immutable. Reconcile and clear the existing batch first.",
    );
  const raw = JSON.stringify(value);
  storage.setItem(outboxKey(scope), raw);
  if (storage.getItem(outboxKey(scope)) !== raw)
    throw new Error("Batch persistence could not be verified.");
}
export function newOutbox(
  scope: BatchScope,
  payloads: InventoryReviewInput[],
): BatchOutbox {
  if (payloads.some((payload) => payload.episodeNumber !== scope.episodeNumber))
    throw new Error("Cannot prepare a batch for another episode.");
  return schema.parse({
    schema: 1,
    owner: scope.owner,
    source: scope.source,
    episode: scope.episode,
    entries: payloads.map((payload) => ({
      payload,
      status: "pending",
      attempted: false,
    })),
  });
}
export function clearOutbox(storage: Storage, scope: BatchScope) {
  const box = readOutbox(storage, scope);
  if (box?.entries.some((e) => e.status === "pending"))
    throw new Error(
      "Reconcile every uncertain operation before clearing this batch.",
    );
  storage.removeItem(outboxKey(scope));
  if (storage.getItem(outboxKey(scope)) !== null)
    throw new Error("Batch removal could not be verified.");
}
export function scopedDraftIds(
  drafts: Record<string, unknown>,
  source: string,
  episode: string,
) {
  return Object.keys(drafts).flatMap((key) => {
    try {
      const value: unknown = JSON.parse(key);
      return Array.isArray(value) &&
        value.length === 3 &&
        value[0] === source &&
        value[1] === episode &&
        typeof value[2] === "string"
        ? [value[2]]
        : [];
    } catch {
      return [];
    }
  });
}
