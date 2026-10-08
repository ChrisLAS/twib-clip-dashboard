import type { Episode } from "@twib/shared";

/** URL state is authoritative; the active draft is only a first-visit default. */
export function chooseEpisode(
  episodes: Episode[],
  requested: string | null,
): Episode | null {
  return (
    episodes.find((episode) => episode.id === requested) ??
    episodes.find((episode) => episode.isActive) ??
    episodes.find((episode) => episode.status === "draft") ??
    episodes[0] ??
    null
  );
}

export function episodeUrl(
  href: string,
  episodeId: string,
  clipId?: string,
): string {
  const url = new URL(href);
  url.searchParams.set("episode", episodeId);
  url.hash = clipId ? `clip/${encodeURIComponent(clipId)}` : "";
  return url.pathname + url.search + url.hash;
}

export function requestedEpisode(href: string): string | null {
  return new URL(href).searchParams.get("episode");
}
