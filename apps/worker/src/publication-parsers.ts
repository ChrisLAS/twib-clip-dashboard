import type { Cue } from "@twib/shared";

export interface FeedEpisode {
  guid: string;
  title: string;
  episodeNumber: number | null;
  publishedAt: string | null;
  enclosure: { url: string; length: string | null; type: string | null } | null;
  transcriptUrl: string | null;
  chaptersUrl: string | null;
}
function entities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity: string) => {
      if (entity[0] === "#") {
        const n =
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        if (n > 0x10ffff || n === 0 || (n >= 0xd800 && n <= 0xdfff))
          throw new Error("Invalid XML character");
        return String.fromCodePoint(n);
      }
      return (
        { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<
          string,
          string
        >
      )[entity.toLowerCase()];
    },
  );
}
interface Node {
  name: string;
  attributes: Record<string, string>;
  text: string;
  children: Node[];
}
/** Small bounded RSS XML parser. DTDs/entities and malformed XML fail closed. */
export function parseFeed(xml: string): FeedEpisode[] {
  if (xml.length > 1048576 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Unsupported or oversized RSS XML");
  const root: Node = { name: "root", attributes: {}, text: "", children: [] };
  const stack = [root];
  const token =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][^<>]*>|[^<]+/gy;
  let offset = 0,
    count = 0;
  while (offset < xml.length) {
    token.lastIndex = offset;
    const match = token.exec(xml);
    if (!match || ++count > 50000)
      throw new Error("Malformed or complex RSS XML");
    const value = match[0];
    offset = token.lastIndex;
    const current = stack[stack.length - 1];
    if (value.startsWith("<!--") || value.startsWith("<?")) continue;
    if (value.startsWith("<![CDATA[")) {
      current.text += value.slice(9, -3);
      continue;
    }
    if (!value.startsWith("<")) {
      current.text += entities(value);
      continue;
    }
    if (value.startsWith("</")) {
      if (stack.length === 1 || value.slice(2, -1).trim() !== current.name)
        throw new Error("Mismatched RSS XML");
      stack.pop();
      continue;
    }
    const opening = /^<([\w:.-]+)([\s\S]*?)(\/?)>$/.exec(value)!;
    if (!opening) throw new Error("Malformed RSS element");
    const attributes: Record<string, string> = Object.create(null);
    const attr = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
    let i = 0;
    while (i < opening[2].length && opening[2].slice(i).trim()) {
      attr.lastIndex = i;
      const a = attr.exec(opening[2]);
      if (!a || a[1] in attributes) throw new Error("Malformed RSS attributes");
      attributes[a[1]] = entities(a[2] ?? a[3]);
      i = attr.lastIndex;
    }
    const node: Node = { name: opening[1], attributes, text: "", children: [] };
    current.children.push(node);
    if (!opening[3]) stack.push(node);
    if (stack.length > 24) throw new Error("RSS nesting exceeds limit");
  }
  if (stack.length !== 1) throw new Error("Truncated RSS XML");
  const rss = root.children.find((n) => n.name === "rss");
  const channel = rss?.children.find((n) => n.name === "channel");
  if (!channel) throw new Error("Expected RSS channel");
  const items = channel.children.filter((n) => n.name === "item");
  if (items.length > 500) throw new Error("RSS exceeds episode limit");
  const result = items.map((item) => {
    for (const name of ["guid", "itunes:episode"]) {
      const identities = item.children
        .filter((node) => node.name === name)
        .map((node) => node.text.trim());
      if (new Set(identities).size > 1)
        throw new Error("Conflicting RSS episode identity fields");
    }
    const text = (name: string) =>
      item.children.find((n) => n.name === name)?.text.trim() ?? "";
    const guid = text("guid"),
      title = text("title");
    if (!guid || guid.length > 1024 || !title || title.length > 2000)
      throw new Error("RSS episode missing valid GUID/title");
    const number = text("itunes:episode");
    const episodeNumber =
      /^\d{1,7}$/.test(number) && Number(number) > 0 ? Number(number) : null;
    const date = text("pubDate");
    const publishedAt =
      date && Number.isFinite(Date.parse(date))
        ? new Date(date).toISOString()
        : null;
    const enclosure = item.children.find(
      (n) => n.name === "enclosure",
    )?.attributes;
    const transcript = item.children.find(
      (n) =>
        n.name === "podcast:transcript" &&
        /^(application\/x-subrip|application\/srt|text\/srt)$/i.test(
          n.attributes.type ?? "",
        ),
    );
    const chapters = item.children.find(
      (n) =>
        n.name === "podcast:chapters" &&
        n.attributes.type === "application/json+chapters",
    );
    return {
      guid,
      title,
      episodeNumber,
      publishedAt,
      enclosure: enclosure?.url
        ? {
            url: enclosure.url,
            length: enclosure.length ?? null,
            type: enclosure.type ?? null,
          }
        : null,
      transcriptUrl: transcript?.attributes.url ?? null,
      chaptersUrl: chapters?.attributes.url ?? null,
    };
  });
  if (new Set(result.map((item) => item.guid)).size !== result.length)
    throw new Error("Duplicate RSS episode GUID");
  return result.sort((a, b) =>
    (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
  );
}
function timestamp(value: string): number {
  const match = /^(\d{2,3}):([0-5]\d):([0-5]\d)[,.](\d{3}|1000)$/.exec(value);
  if (!match) throw new Error("Invalid SRT timestamp");
  // A source exporter emits ,1000. Arithmetic naturally carries to the next second.
  return (
    (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) *
      1000 +
    Number(match[4])
  );
}
export function parseSrt(original: string): Cue[] {
  if (original.length > 524288) throw new Error("Transcript exceeds limit");
  const normalized = original
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) throw new Error("Empty transcript");
  const blocks = normalized.split(/\n\s*\n/);
  if (blocks.length > 6000) throw new Error("Transcript exceeds cue limit");
  let previous = -1;
  return blocks.map((block, index) => {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0])) lines.shift();
    const timing = /^(\S+)\s+-->\s+(\S+)\s*$/.exec(lines.shift() ?? "");
    if (!timing) throw new Error("Malformed SRT cue");
    const startMs = timestamp(timing[1]),
      endMs = timestamp(timing[2]);
    const text = lines.join("\n").trim();
    if (startMs < previous || endMs <= startMs || endMs > 604800000 || !text)
      throw new Error("Invalid SRT cue range or text");
    previous = startMs;
    return { id: String(index + 1), startMs, endMs, text };
  });
}
export interface PublicationChapter {
  startMs: number;
  title: string;
}
export function parseChapters(text: string): PublicationChapter[] {
  if (text.length > 131072) throw new Error("Chapters exceed limit");
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    !("chapters" in value) ||
    !Array.isArray(value.chapters) ||
    value.chapters.length > 1000
  )
    throw new Error("Invalid chapters document");
  let previous = -1;
  return value.chapters.map((chapter: unknown) => {
    if (
      !chapter ||
      typeof chapter !== "object" ||
      !("startTime" in chapter) ||
      typeof chapter.startTime !== "number" ||
      !Number.isFinite(chapter.startTime) ||
      chapter.startTime < 0 ||
      chapter.startTime > 604800 ||
      chapter.startTime < previous ||
      !("title" in chapter) ||
      typeof chapter.title !== "string" ||
      chapter.title.length > 2000
    )
      throw new Error("Invalid chapter");
    previous = chapter.startTime;
    return {
      startMs: Math.round(chapter.startTime * 1000),
      title: chapter.title,
    };
  });
}
