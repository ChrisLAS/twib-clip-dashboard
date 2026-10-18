import {
  listIntakeWork,
  requestIntakeWork,
  selectIntakeRange,
  retryIntakeWork,
} from "./capture-jobs/intake-work";
import { proposalRange } from "./capture-jobs/plan";
import { requireKind } from "./capture-jobs/scope";
import {
  cutsEnabled,
  executionEnabled,
  planningEnabled,
  attachCuts,
  enqueueCut,
  retryCut,
  readCut,
  cutView,
} from "./capture-jobs/cut";
import { machineJobs, requireJobsEnabled, jobBody } from "./capture-jobs/http";
import { createJob, listJobs, retryJob } from "./capture-jobs/store";
import { ingestInventory } from "./inventory/http";
import { inventoryEpisodeSelection, listInventory } from "./inventory/store";
import { saveInventoryReview } from "./inventory/review";
import {
  renderTranscriptInputSchema,
  importRenderTranscriptAsset,
  selectRenderTranscriptAsset,
} from "./render-transcripts";
import {
  publicationStatus,
  publicationConfigured,
  syncPublication,
  getPublishedTranscript,
} from "./publication";
import {
  getEditorialProfile,
  getEditorialContext,
  listEditorialHistory,
  mutateEditorial,
  recordEditorialReceipt,
} from "./editorial";
import {
  listAiringEvidence,
  ingestAiringEvidence,
  decideAiringEvidence,
  airingInputSchema,
  airingDecisionSchema,
  airingSourceFingerprint,
} from "./airing";
import { z } from "zod";
import type { Env } from "./env";
import { authenticate, csrfToken, guardMutation, isDemo } from "./auth";
import { HttpError, json } from "./errors";
import {
  getEpisode,
  getRender,
  listEpisodes,
  mutate,
  operation,
  events,
} from "./store";
import { media } from "./media";
import { googleConfigured } from "./google";
import { pullManifest } from "./importer";
import { seedDemo } from "./fixtures";
import { catalogStatus } from "./catalog";
import {
  listIntake,
  mutateIntake,
  intakeCreateSchema,
  intakeUpdateSchema,
} from "./intake";
const common = {
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z
    .string()
    .min(8)
    .max(120)
    .regex(/^[a-zA-Z0-9_-]+$/),
};
const reviewInput = z
  .object({
    ...common,
    decision: z.enum(["up", "down", "defer", "clear"]),
    note: z.string().max(5000).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
const visibilityInput = z
  .object({ ...common, visibility: z.enum(["visible", "hidden"]) })
  .strict();
async function body(request: Request, limit = 12000): Promise<unknown> {
  if (Number(request.headers.get("Content-Length")) > limit)
    throw new HttpError(413, "REQUEST_TOO_LARGE", "Request is too large.");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) {
          await reader.cancel();
          throw new HttpError(
            413,
            "REQUEST_TOO_LARGE",
            "Request is too large.",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON request.");
  }
}
export default {
  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    // Offset publication work gets its own invocation and unchanged CPU ceiling.
    if (controller.cron === "2 * * * *") {
      if (publicationConfigured(env)) ctx.waitUntil(syncPublication(env));
      return;
    }
    if (controller.cron !== "*/5 * * * *")
      throw new Error("Unrecognized scheduled trigger; no work was started.");
    // No public endpoint or browser credentials are involved in this trigger.
    ctx.waitUntil(
      pullManifest(env).catch((error: unknown) => {
        // Overlap is an expected no-op, not a failed run. Other failures have
        // already been safely persisted and remain visible in Cron Past Events.
        if (!(error instanceof HttpError && error.code === "SYNC_IN_PROGRESS"))
          throw error;
      }),
    );
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (new URL(request.url).pathname.startsWith("/api/v1/capture-jobs/"))
        return await machineJobs(request, env);
      if (new URL(request.url).pathname.startsWith("/api/capture-jobs")) {
        requireJobsEnabled(env);
        if (isDemo(request, env))
          throw new HttpError(
            403,
            "OWNER_REQUIRED",
            "Demo cannot operate capture jobs.",
          );
        requireKind(env, "capture");
      }
      if (
        new URL(request.url).pathname.startsWith("/api/inventory/cut-requests/")
      ) {
        if (!executionEnabled(env))
          throw new HttpError(
            503,
            "CUT_JOBS_DISABLED",
            "Cut execution is not activated.",
          );
        if (isDemo(request, env))
          throw new HttpError(
            403,
            "OWNER_REQUIRED",
            "An owner session is required.",
          );
      }
      // Separate machine adapter; owner authentication and demo bypass never
      // authorize inventory writes. Missing private configuration stays closed.
      if (/^\/api\/v[12]\/number-one\//.test(new URL(request.url).pathname))
        return await ingestInventory(request, env);
      const owner = await authenticate(request, env);
      const demo = isDemo(request, env);
      if (demo) await seedDemo(env.DB);
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      if (method === "POST") await guardMutation(request, env, owner);
      let result: Response;
      if (
        /^\/api\/inventory\/cut-requests\/[0-9a-f-]{36}\/(queue|retry)$/.test(
          path,
        ) &&
        method === "POST"
      ) {
        const id = path.split("/")[4];
        result = json(
          path.endsWith("/retry")
            ? await retryCut(env.DB, id, await body(request), owner)
            : await enqueueCut(env.DB, id, owner),
        );
      } else if (
        /^\/api\/inventory\/plan-requests\/[0-9a-f-]{36}\/proposal$/.test(
          path,
        ) &&
        method === "GET"
      ) {
        if (demo)
          throw new HttpError(
            403,
            "OWNER_REQUIRED",
            "An owner session is required.",
          );
        result = json(await proposalRange(env.DB, path.split("/")[4], owner));
      } else if (path === "/api/capture-jobs" && method === "POST")
        result = json(await createJob(env.DB, await jobBody(request), owner));
      else if (path === "/api/capture-jobs" && method === "GET")
        result = json(await listJobs(env.DB));
      else if (
        /^\/api\/capture-jobs\/[0-9a-f-]{36}\/retry$/.test(path) &&
        method === "POST"
      )
        result = json(
          await retryJob(env.DB, path.split("/")[3], await jobBody(request)),
        );
      else if (path === "/api/session" && method === "GET")
        result = json({
          owner,
          csrfToken: await csrfToken(owner, env, demo),
          mode: demo ? "demo" : "production",
          integrations: {
            drive: googleConfigured(env),
            producer: !!env.PRODUCER_SHEET_ID,
            intakeProducer: false,
          },
        });
      else if (path === "/api/inventory" && method === "GET") {
        const selection = await inventoryEpisodeSelection(url.searchParams);
        const inventory = await listInventory(
          env.DB,
          selection.episodeId,
          url.searchParams.get("after"),
          {
            episodeNumber: selection.episodeNumber,
            group: url.searchParams.get("group"),
            status: url.searchParams.get("status"),
            query: url.searchParams.get("q"),
            sort: url.searchParams.get("sort"),
            direction: url.searchParams.get("direction"),
            review: url.searchParams.get("review"),
            groupFolders: url.searchParams.get("groupFolders") === "true",
            duration: url.searchParams.get("duration"),
            ingestionEnabled: env.INVENTORY_INGEST_ENABLED === "true",
          },
        );
        if (cutsEnabled(env) && !demo) {
          const cuts = await attachCuts(env.DB, inventory.items);
          for (const item of inventory.items)
            item.cutRequests = cuts.filter((c) => c.parentItemId === item.id);
        }
        result = json({
          ...inventory,
          cutRequestsEnabled: cutsEnabled(env) && !demo,
          cutExecutionEnabled: executionEnabled(env) && !demo,
          cutPlanningEnabled: planningEnabled(env) && !demo,
          cutFirstPassAutoEnabled:
            env.CUT_FIRST_PASS_AUTO_ENABLED === "true" &&
            planningEnabled(env) &&
            executionEnabled(env) &&
            !demo,
        });
      } else if (path === "/api/inventory/review" && method === "POST") {
        const input = await body(request, 24000);
        if (
          input &&
          typeof input === "object" &&
          "cutSpec" in input &&
          (!cutsEnabled(env) || demo)
        )
          throw new HttpError(
            503,
            "CUT_REQUESTS_DISABLED",
            "Structured cut requests are not activated.",
          );
        const review = await saveInventoryReview(env.DB, input, owner);
        if (review.cutRequestId) {
          if (executionEnabled(env) || planningEnabled(env)) {
            const cut = await readCut(env.DB, review.cutRequestId);
            const isPlan = cut && cutView(cut).spec.kind !== "range";
            if (
              cut &&
              (isPlan ? planningEnabled(env) : executionEnabled(env))
            ) {
              try {
                await enqueueCut(
                  env.DB,
                  review.cutRequestId,
                  owner,
                  Date.now(),
                  Boolean(isPlan),
                );
              } catch (error) {
                if (!(error instanceof HttpError)) throw error;
                review.cutQueueError = error.code;
              }
            }
          }
          const cut = await readCut(env.DB, review.cutRequestId);
          if (cut) review.cutRequest = cutView(cut);
        }
        result = json(review);
      } else if (path === "/api/publication" && method === "GET")
        result = json(await publicationStatus(env));
      else if (path === "/api/publication/sync" && method === "POST") {
        z.object({})
          .strict()
          .parse(await body(request));
        result = json(await syncPublication(env, { force: true }));
      } else if (path === "/api/editorial/profile" && method === "GET")
        result = json(await getEditorialProfile(env.DB, owner));
      else if (path === "/api/editorial/history" && method === "GET")
        result = json(await listEditorialHistory(env.DB, owner));
      else if (path === "/api/editorial/context" && method === "GET")
        result = json(
          await getEditorialContext(
            env.DB,
            owner,
            url.searchParams.get("episodeId"),
            url.searchParams.get("renderId"),
          ),
        );
      else if (path === "/api/editorial/profile" && method === "POST")
        result = json(
          await mutateEditorial(
            env.DB,
            owner,
            "profile",
            await body(request, 48000),
          ),
        );
      else if (path === "/api/editorial/feedback" && method === "POST")
        result = json(
          await mutateEditorial(env.DB, owner, "feedback", await body(request)),
        );
      else if (path === "/api/editorial/receipts" && method === "POST")
        result = json(
          await recordEditorialReceipt(env.DB, owner, await body(request)),
        );
      else if (
        /^\/api\/renders\/[\w-]+\/airing$/.test(path) &&
        method === "GET"
      )
        result = json(
          await listAiringEvidence(env.DB, path.split("/")[3], owner),
        );
      else if (
        /^\/api\/renders\/[\w-]+\/transcripts$/.test(path) &&
        method === "POST"
      ) {
        const input = renderTranscriptInputSchema.parse(
          await body(request, 1000000),
        );
        if (input.renderId !== path.split("/")[3])
          throw new HttpError(
            422,
            "RENDER_ID_MISMATCH",
            "Transcript render must match the requested render.",
          );
        result = json(await importRenderTranscriptAsset(env.DB, input, owner));
      } else if (path === "/api/airing/evidence" && method === "POST")
        result = json(
          await ingestAiringEvidence(
            env.DB,
            airingInputSchema.parse(await body(request, 120000)),
            owner,
          ),
        );
      else if (/^\/api\/airing\/[\w-]+$/.test(path) && method === "POST")
        result = json(
          await decideAiringEvidence(
            env.DB,
            path.split("/")[3],
            airingDecisionSchema.parse(await body(request)),
            owner,
          ),
        );
      else if (path === "/api/airing/input" && method === "GET") {
        const renderId = z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,120}$/)
          .parse(url.searchParams.get("renderId"));
        const episodeId = z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,120}$/)
          .parse(url.searchParams.get("episodeId"));
        const render = await getRender(env.DB, renderId);
        const sourceTranscriptAsset = await selectRenderTranscriptAsset(
          env.DB,
          render,
          owner,
        );
        result = json({
          render,
          sourceTranscriptAsset,
          sourceFingerprint: await airingSourceFingerprint(
            render,
            sourceTranscriptAsset,
          ),
          publication: await getPublishedTranscript(env.DB, episodeId),
        });
      } else if (path === "/api/catalog/status" && method === "GET")
        result = json(await catalogStatus(env));
      else if (path === "/api/episodes" && method === "GET")
        result = json(await listEpisodes(env.DB, owner));
      else if (/^\/api\/episodes\/[\w-]+$/.test(path) && method === "GET")
        result = json(await getEpisode(env.DB, path.split("/")[3], owner));
      else if (path === "/api/intake/work" && method === "GET")
        result = json(
          demo
            ? { enabled: false, dispatchEnabled: false, jobs: [] }
            : await listIntakeWork(env, owner),
        );
      else if (
        /^\/api\/intake\/[\w-]+\/work$/.test(path) &&
        method === "POST"
      ) {
        if (demo)
          throw new HttpError(
            403,
            "OWNER_REQUIRED",
            "An owner session is required.",
          );
        result = json(
          await requestIntakeWork(
            env,
            path.split("/")[3],
            await body(request),
            owner,
          ),
        );
      } else if (
        /^\/api\/intake\/[\w-]+\/work\/[0-9a-f-]{36}\/retry$/.test(path) &&
        method === "POST"
      ) {
        if (demo)
          throw new HttpError(
            403,
            "OWNER_REQUIRED",
            "An owner session is required.",
          );
        result = json(
          await retryIntakeWork(
            env,
            path.split("/")[3],
            path.split("/")[5],
            await body(request),
            owner,
          ),
        );
      } else if (
        /^\/api\/intake\/[\w-]+\/work\/[0-9a-f-]{36}\/range$/.test(path) &&
        method === "POST"
      ) {
        if (demo)
          throw new HttpError(
            403,
            "OWNER_REQUIRED",
            "An owner session is required.",
          );
        result = json(
          await selectIntakeRange(
            env,
            path.split("/")[3],
            path.split("/")[5],
            await body(request),
            owner,
          ),
        );
      } else if (path === "/api/intake" && method === "GET") {
        const episodeId = url.searchParams.get("episodeId");
        if (
          episodeId !== null &&
          episodeId !== "unassigned" &&
          !/^[a-zA-Z0-9_-]{1,120}$/.test(episodeId)
        )
          throw new HttpError(
            422,
            "INVALID_EPISODE",
            "Choose a valid episode.",
          );
        result = json(
          await listIntake(
            env.DB,
            owner,
            episodeId === null
              ? undefined
              : episodeId === "unassigned"
                ? null
                : episodeId,
          ),
        );
      } else if (path === "/api/intake" && method === "POST")
        result = json(
          await mutateIntake(
            env.DB,
            null,
            intakeCreateSchema.parse(await body(request)),
            owner,
          ),
        );
      else if (/^\/api\/intake\/[\w-]+$/.test(path) && method === "POST")
        result = json(
          await mutateIntake(
            env.DB,
            path.split("/")[3],
            intakeUpdateSchema.parse(await body(request)),
            owner,
          ),
        );
      else if (/^\/api\/renders\/[\w-]+$/.test(path) && method === "GET")
        result = json(await getRender(env.DB, path.split("/")[3]));
      else if (
        /^\/api\/renders\/[\w-]+\/reviews$/.test(path) &&
        method === "POST"
      )
        result = json(
          await mutate(
            env.DB,
            "review",
            path.split("/")[3],
            reviewInput.parse(await body(request)),
            owner,
          ),
        );
      else if (
        /^\/api\/clips\/[\w-]+\/visibility$/.test(path) &&
        method === "POST"
      )
        result = json(
          await mutate(
            env.DB,
            "visibility",
            path.split("/")[3],
            visibilityInput.parse(await body(request)),
            owner,
          ),
        );
      else if (/^\/api\/operations\/[\w-]+$/.test(path) && method === "GET") {
        const op = await operation(env.DB, path.split("/")[3], owner);
        if (!op)
          throw new HttpError(
            404,
            "OPERATION_UNKNOWN",
            "No committed operation was found.",
          );
        result = json(JSON.parse(op.response));
      } else if (
        /^\/api\/attempts\/[\w-]+\/events$/.test(path) &&
        method === "GET"
      )
        result = json(await events(env.DB, path.split("/")[3]));
      else if (
        /^\/media\/[\w-]+\/(original|proxy|thumbnail)$/.test(path) &&
        ["GET", "HEAD"].includes(method)
      )
        result = await media(
          request,
          env,
          path.split("/")[2],
          path.split("/")[3],
        );
      else if (path === "/api/import" && method === "POST") {
        await body(request);
        result = json(await pullManifest(env));
      } else if (
        !path.startsWith("/api/") &&
        !path.startsWith("/media/") &&
        ["GET", "HEAD"].includes(method) &&
        env.ASSETS
      )
        result = await env.ASSETS.fetch(request);
      else throw new HttpError(404, "NOT_FOUND", "Route not found.");
      const headers = new Headers(result.headers);
      headers.set("Cache-Control", "private, no-store, no-transform");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("X-Frame-Options", "DENY");
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      return new Response(result.body, { status: result.status, headers });
    } catch (e) {
      if (e instanceof HttpError)
        return json(
          {
            error: { code: e.code, message: e.message },
            ...(e.duplicateMatches
              ? {
                  duplicateMatches: e.duplicateMatches,
                  existingIntakeIds: e.duplicateMatches
                    .filter((match) => match.kind === "intake")
                    .map((match) => match.id),
                }
              : {}),
            ...(e.currentRevision !== undefined
              ? { currentRevision: e.currentRevision }
              : {}),
          },
          e.status,
        );
      if (e instanceof z.ZodError)
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "The request does not match the expected schema.",
            },
          },
          422,
        );
      return json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message:
              "The request failed safely. Your prior data is unchanged; reconcile uncertain saves before retrying.",
          },
        },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
