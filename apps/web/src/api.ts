import type {
  Episode,
  EpisodeDetail,
  Session,
  Review,
  ReviewInput,
  VisibilityInput,
} from "@twib/shared";
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    credentials: "same-origin",
    signal: AbortSignal.timeout(20000),
    ...init,
  });
  if (!r.ok) {
    const payload: unknown = await r.json().catch(() => null);
    let message = `Request failed (${r.status})`;
    if (payload && typeof payload === "object" && "error" in payload) {
      const detail = payload.error;
      if (
        detail &&
        typeof detail === "object" &&
        "message" in detail &&
        typeof detail.message === "string"
      ) {
        message = detail.message;
      }
    }
    throw new RequestError(message, r.status);
  }
  return r.json();
}
export const api = {
  importApproved: async (csrf: string, signal?: AbortSignal) => {
    try {
      return await request<{ imported: number }>("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: "{}",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
      });
    } catch (error) {
      if (error instanceof RequestError && error.status < 500) throw error;
      throw new Error(
        `${error instanceof RequestError ? error.message + " " : ""}Import could not be confirmed. Refresh the slate before retrying; completed records are safe to recheck.`,
      );
    }
  },
  session: () => request<Session>("/api/session"),
  episodes: () => request<Episode[]>("/api/episodes"),
  episode: (id: string) =>
    request<EpisodeDetail>(`/api/episodes/${encodeURIComponent(id)}`),
  review: (id: string, body: ReviewInput, csrf: string) =>
    mutate<Review>(
      `/api/renders/${encodeURIComponent(id)}/reviews`,
      body,
      csrf,
    ),
  visibility: (id: string, body: VisibilityInput, csrf: string) =>
    mutate<{ visibility: "visible" | "hidden"; revision: number }>(
      `/api/clips/${encodeURIComponent(id)}/visibility`,
      body,
      csrf,
    ),
};
async function mutate<T>(
  path: string,
  body: ReviewInput | VisibilityInput,
  csrf: string,
): Promise<T> {
  try {
    return await request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof RequestError && error.status < 500) throw error;
    try {
      return await request<T>(
        `/api/operations/${encodeURIComponent(body.idempotencyKey)}`,
      );
    } catch {
      throw new Error(
        "Save could not be confirmed. Keep this note and refresh before retrying.",
      );
    }
  }
}
export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function timecode(ms: number) {
  return new Date(ms).toISOString().slice(11, 23);
}
export function date(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "Unknown";
}
