import type { ManualIntake } from "@twib/shared";

/** Accept seconds, m:ss or h:mm:ss; never coerce missing/invalid input to zero. */
export function parseIntakeTime(input: string): number | null {
  const value = input.trim();
  if (!value) return null;
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(value)) return Number.NaN;
  const parts = value.split(":").map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return Number.NaN;
  const milliseconds = Math.round(
    parts.reduce((total, part) => total * 60 + part, 0) * 1000,
  );
  return Number.isSafeInteger(milliseconds) ? milliseconds : Number.NaN;
}

export function intakeTime(milliseconds: number | null): string {
  if (milliseconds === null) return "";
  const seconds = milliseconds / 1000;
  const minutes = Math.floor(seconds / 60);
  const [whole, fraction] = (seconds % 60)
    .toFixed(3)
    .replace(/\.?0+$/, "")
    .split(".");
  return `${minutes}:${whole.padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
}

export function preserveIntakes(
  previous: ManualIntake[],
  incoming: ManualIntake[],
): ManualIntake[] {
  const loaded = new Map(previous.map((item) => [item.id, item]));
  return incoming.map((item) => {
    const prior = loaded.get(item.id);
    return prior && prior.revision > item.revision ? prior : item;
  });
}

export function pendingIntakes(
  items: ManualIntake[],
  episodeId: string | null,
): ManualIntake[] {
  return items.filter(
    (item) =>
      item.episodeId === episodeId && item.status === "awaiting_processing",
  );
}
