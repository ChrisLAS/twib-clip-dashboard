import type { Episode } from "@twib/shared";
/** Display only verified workspace metadata; never guess a title from an ID. */
export function airingTargetLabel(
  episodeId: string,
  episodes: Episode[],
): string {
  const episode = episodes.find((item) => item.id === episodeId);
  return episode
    ? `Episode ${episode.number}${episode.title ? ` · ${episode.title}` : ""} (${episodeId})`
    : `Episode ${episodeId}`;
}
export function shortFingerprint(value: string): string {
  return value.slice(0, 12);
}
