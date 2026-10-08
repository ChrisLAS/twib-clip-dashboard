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
  const text = await request.text();
  if (text.length > limit)
    throw new HttpError(413, "REQUEST_TOO_LARGE", "Request is too large.");
  try {
    return JSON.parse(text);
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
      const owner = await authenticate(request, env);
      const demo = isDemo(request, env);
      if (demo) await seedDemo(env.DB);
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      if (method === "POST") await guardMutation(request, env, owner);
      let result: Response;
      if (path === "/api/session" && method === "GET")
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
      else if (path === "/api/publication" && method === "GET")
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
      else if (path === "/api/airing/evidence" && method === "POST")
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
        result = json({
          render,
          sourceFingerprint: await airingSourceFingerprint(render),
          publication: await getPublishedTranscript(env.DB, episodeId),
        });
      } else if (path === "/api/catalog/status" && method === "GET")
        result = json(await catalogStatus(env));
      else if (path === "/api/episodes" && method === "GET")
        result = json(await listEpisodes(env.DB, owner));
      else if (/^\/api\/episodes\/[\w-]+$/.test(path) && method === "GET")
        result = json(await getEpisode(env.DB, path.split("/")[3], owner));
      else if (path === "/api/intake" && method === "GET") {
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
