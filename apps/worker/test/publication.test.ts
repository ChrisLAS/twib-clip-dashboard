import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import {
  getPublishedEdition,
  nextPublicationCheck,
  sha256,
  syncPublication,
  validatePublicationUrl,
  type PublicationEnv,
} from "../src/publication";
import { parseChapters, parseFeed, parseSrt } from "../src/publication-parsers";

class Statement {
  values: (string | number | null)[] = [];
  constructor(
    private sqlite: DatabaseSync,
    public sql: string,
  ) {}
  bind(...values: (string | number | null)[]) {
    this.values = values;
    return this;
  }
  async first<T>() {
    return (this.sqlite.prepare(this.sql).get(...this.values) ??
      null) as T | null;
  }
  async all<T>() {
    return {
      results: this.sqlite.prepare(this.sql).all(...this.values) as T[],
    };
  }
  async run() {
    return this.sqlite.prepare(this.sql).run(...this.values);
  }
}
let sqlite: DatabaseSync, env: PublicationEnv;
let beforeBatch: ((statements: Statement[]) => void) | undefined;
const srt = "1\n00:00:59,1000 --> 00:01:02,500\nFictional speech only.\n";
function feed(transcript = true, chapter = true, guid = "fiction-one") {
  return `<?xml version="1.0"?><rss xmlns:itunes="urn:itunes" xmlns:podcast="urn:podcast"><channel><title>Fixture</title><item><guid>${guid}</guid><title>Fiction &amp; Test</title><itunes:episode>7</itunes:episode><pubDate>Tue, 06 Oct 2026 12:00:00 GMT</pubDate><enclosure url="https://audio.example.com/example.mp3" length="300" type="audio/mpeg"/>${transcript ? '<podcast:transcript url="https://assets.example.com/transcript.srt" type="application/x-subrip"/>' : ""}${chapter ? '<podcast:chapters url="https://assets.example.com/chapters.json" type="application/json+chapters"/>' : ""}</item></channel></rss>`;
}
function responses(transcriptStatus = 200) {
  return vi.fn(async (url: string) =>
    url.includes("feed")
      ? new Response(feed(), { headers: { etag: '"feed-one"' } })
      : url.endsWith(".srt")
        ? new Response(transcriptStatus === 200 ? srt : "denied", {
            status: transcriptStatus,
            headers: { etag: '"srt-one"' },
          })
        : new Response('{"chapters":[{"startTime":0,"title":"Start"}]}', {
            headers: { etag: '"chapters-one"' },
          }),
  );
}
beforeEach(() => {
  beforeBatch = undefined;
  sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).sort())
    sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
  const db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    batch: async (statements: Statement[]) => {
      beforeBatch?.(statements);
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
  env = {
    DB: db,
    APP_ENV: "production",
    PUBLICATION_FEED_URL: "https://feeds.example.com/feed.xml",
    PUBLICATION_ALLOWED_HOSTS: "feeds.example.com,assets.example.com",
  };
  sqlite
    .prepare(
      "INSERT INTO episode_workspaces(id,data,status,is_active) VALUES(?,?,?,?)",
    )
    .run(
      "host-seven",
      JSON.stringify({
        id: "host-seven",
        number: 7,
        title: "Host title",
        publishedGuid: null,
      }),
      "draft",
      1,
    );
});
afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.close();
});
describe("publication parsers and safe fetching", () => {
  it("extracts exact GUID, number, namespaced assets, entity text, date", () => {
    expect(parseFeed(feed())[0]).toMatchObject({
      guid: "fiction-one",
      title: "Fiction & Test",
      episodeNumber: 7,
      transcriptUrl: "https://assets.example.com/transcript.srt",
    });
  });
  it.each([
    "<guid>conflicting-guid</guid>",
    "<itunes:episode>8</itunes:episode>",
  ])("fails closed on conflicting repeated identity %s", async (extra) => {
    const ambiguous = feed().replace("</item>", extra + "</item>");
    expect(() => parseFeed(ambiguous)).toThrow(
      "Conflicting RSS episode identity fields",
    );
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    vi.stubGlobal("fetch", async () => new Response(ambiguous));
    const status = await syncPublication(env);
    expect(status.assets.rss.state).toBe("error");
    expect(status.lastError).not.toBeNull();
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
    ).toMatchObject({ n: 0 });
    expect(
      sqlite
        .prepare("SELECT id FROM episode_workspaces WHERE is_active=1")
        .get(),
    ).toMatchObject({ id: "host-seven" });
  });
  it("accepts repeated identical RSS identity values", () => {
    expect(
      parseFeed(
        feed().replace(
          "</item>",
          "<guid>fiction-one</guid><itunes:episode>7</itunes:episode></item>",
        ),
      )[0],
    ).toMatchObject({ guid: "fiction-one", episodeNumber: 7 });
  });
  it("carries exporter ,1000 across minute boundary without changing source hash", async () => {
    expect(parseSrt(srt)[0]).toMatchObject({ startMs: 60000, endMs: 62500 });
    expect(await sha256(srt)).not.toBe(
      await sha256(srt.replace("00:00:59,1000", "00:01:00,000")),
    );
    expect(parseSrt(srt)).toEqual(
      parseSrt(srt.replace("00:00:59,1000", "00:01:00,000")),
    );
  });
  it("rejects DTD/entity expansion, truncated XML, malformed cues and chapters", () => {
    expect(() => parseFeed("<!DOCTYPE rss>" + feed())).toThrow();
    expect(() => parseFeed(feed().slice(0, -8))).toThrow();
    expect(() => parseSrt(srt.replace("59,1000", "59,1001"))).toThrow();
    expect(() =>
      parseChapters('{"chapters":[{"startTime":-1,"title":"Invalid"}]}'),
    ).toThrow();
  });
  it.each([
    "http://feeds.example.com/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://2130706433/x",
    "https://feeds.example.com.evil.com/x",
    "https://user:pass@feeds.example.com/x",
    "https://feeds.example.com:444/x",
    "https://metadata.internal/x",
  ])("blocks URL %s", (url) =>
    expect(() =>
      validatePublicationUrl(url, [
        "feeds.example.com",
        "127.0.0.1",
        "metadata.internal",
      ]),
    ).toThrow(),
  );
  it("ingests independent assets and keeps active workspace unchanged", async () => {
    vi.stubGlobal("fetch", responses());
    const status = await syncPublication(env);
    expect(status.lastError).toBeNull();
    expect(status.latest?.episodeId).toBe("host-seven");
    expect(status.assets.transcript.state).toBe("ready");
    expect(status.assets.chapters.state).toBe("ready");
    expect(status.latest?.mediaFingerprint).toBeNull();
    expect(
      sqlite
        .prepare(
          "SELECT is_active,status,data FROM episode_workspaces WHERE id=?",
        )
        .get("host-seven"),
    ).toMatchObject({ is_active: 1, status: "draft" });
    expect(await getPublishedEdition(env.DB, "host-seven")).not.toBeNull();
  });
  it("distinguishes manual success from observed scheduled success", async () => {
    vi.stubGlobal("fetch", responses());
    const manual = await syncPublication(env, { force: true });
    expect(manual.lastSuccessAt).not.toBeNull();
    expect(manual.lastScheduledSuccessAt).toBeNull();
    sqlite.exec("UPDATE publication_sync SET next_check_at=0");
    const scheduled = await syncPublication(env);
    expect(scheduled.lastScheduledSuccessAt).not.toBeNull();
  });
  it("gates the five-minute cron hourly and supports explicit refresh", async () => {
    const mock = responses();
    vi.stubGlobal("fetch", mock);
    await syncPublication(env);
    await syncPublication(env);
    expect(mock).toHaveBeenCalledTimes(3);
    await syncPublication(env, { force: true });
    expect(mock).toHaveBeenCalledTimes(6);
  });
  it("reuses 304 bodies but retries every independently advertised asset", async () => {
    vi.stubGlobal("fetch", responses());
    const first = await syncPublication(env);
    const mock = vi.fn(async () => new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", mock);
    const second = await syncPublication(env, { force: true });
    expect(second.latest?.editionFingerprint).toBe(
      first.latest?.editionFingerprint,
    );
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403])(
    "reports HTTP %s blocked while chapters succeed, then retries",
    async (status) => {
      vi.stubGlobal("fetch", responses(status));
      const blocked = await syncPublication(env);
      expect(blocked.assets.transcript.state).toBe("blocked");
      expect(blocked.assets.chapters.state).toBe("ready");
      expect(await getPublishedEdition(env.DB, "host-seven")).toBeNull();
      sqlite.exec("UPDATE publication_assets SET next_retry_at=0");
      vi.stubGlobal("fetch", responses());
      expect(
        (await syncPublication(env, { force: true })).assets.transcript.state,
      ).toBe("ready");
    },
  );
  it("failed refresh preserves prior content but excludes stale verification", async () => {
    vi.stubGlobal("fetch", responses());
    const first = await syncPublication(env);
    vi.stubGlobal("fetch", responses(403));
    const next = await syncPublication(env, { force: true });
    expect(next.assets.transcript.hash).toBe(first.assets.transcript.hash);
    expect(await getPublishedEdition(env.DB, "host-seven")).toBeNull();
  });
  it("rejects redirects to untrusted hosts without requesting them", async () => {
    const mock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/private" },
        }),
    );
    vi.stubGlobal("fetch", mock);
    expect((await syncPublication(env)).assets.rss.state).toBe("error");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("rejects streaming bodies above the cap and never logs their content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(1048577))),
    );
    const status = await syncPublication(env);
    expect(status.assets.rss.state).toBe("error");
    expect(status.lastError).not.toContain("https:");
  });
  it("defaults off, then atomically publishes and advances once when opted in", async () => {
    vi.stubGlobal("fetch", responses());
    expect((await syncPublication(env)).rollover.enabled).toBe(false);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM episode_workspaces").get(),
    ).toMatchObject({ n: 1 });
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    await syncPublication(env, { force: true });
    await syncPublication(env, { force: true });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM episode_workspaces").get(),
    ).toMatchObject({ n: 2 });
    expect(
      sqlite
        .prepare("SELECT id FROM episode_workspaces WHERE is_active=1")
        .get(),
    ).toMatchObject({ id: "twib-8" });
    const old = sqlite
      .prepare("SELECT * FROM episode_workspaces WHERE id='host-seven'")
      .get()!;
    expect(old).toMatchObject({
      status: "published",
      is_active: 0,
      revision: 2,
    });
    expect(JSON.parse(old.data as string)).toMatchObject({
      title: "Host title",
      publishedGuid: "fiction-one",
    });
    expect(
      sqlite
        .prepare(
          "SELECT upload_folder_url FROM episode_workspaces WHERE id='twib-8'",
        )
        .get(),
    ).toMatchObject({ upload_folder_url: null });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
    ).toMatchObject({ n: 1 });
  });
  it("preserves existing next draft, current title, clips, reviews and intakes", async () => {
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    const nextData = JSON.stringify({
      id: "host-eight",
      number: 8,
      title: "Prepared host title",
      subtitle: "Notes",
      publishedGuid: null,
    });
    sqlite
      .prepare(
        "INSERT INTO episode_workspaces(id,data,status,upload_folder_url) VALUES(?,?,'draft',?)",
      )
      .run(
        "host-eight",
        nextData,
        "https://drive.google.com/drive/folders/fixture",
      );
    sqlite
      .prepare("INSERT INTO episodes(id,data) VALUES('host-seven',?)")
      .run(JSON.stringify({ id: "host-seven", number: 7 }));
    sqlite
      .prepare(
        "INSERT INTO clips(id,episode_id,data) VALUES('clip','host-seven','{}')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO renders(id,clip_id,data,note,decision) VALUES('render','clip','{}','Host review','up')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO manual_intake(id,owner,episode_id,canonical_url,status,revision,data) VALUES('intake','host','host-seven','https://example.com/source','awaiting_processing',1,?)",
      )
      .run(
        JSON.stringify({
          id: "intake",
          episodeId: "host-seven",
          canonicalUrl: "https://example.com/source",
          status: "awaiting_processing",
          revision: 1,
          inMs: null,
          outMs: null,
        }),
      );
    const snapshots = ["clips", "renders", "manual_intake"].map((t) =>
      sqlite.prepare(`SELECT * FROM ${t}`).all(),
    );
    vi.stubGlobal("fetch", responses());
    const status = await syncPublication(env);
    expect(status.rollover.issue).toBeNull();
    expect(status.rollover.lastCompletedAt).not.toBeNull();
    expect(
      sqlite
        .prepare(
          "SELECT data,is_active,upload_folder_url FROM episode_workspaces WHERE id='host-eight'",
        )
        .get(),
    ).toMatchObject({
      data: nextData,
      is_active: 1,
      upload_folder_url: "https://drive.google.com/drive/folders/fixture",
    });
    expect(
      ["clips", "renders", "manual_intake"].map((t) =>
        sqlite.prepare(`SELECT * FROM ${t}`).all(),
      ),
    ).toEqual(snapshots);
  });
  it.each(["revision", "host choice", "next contents", "catalog", "ABA"])(
    "fences an intervening %s change at the write boundary",
    async (change) => {
      env.PUBLICATION_AUTO_ROLLOVER = "true";
      sqlite
        .prepare(
          "INSERT INTO episode_workspaces(id,data,status) VALUES('host-eight',?,'draft')",
        )
        .run(JSON.stringify({ id: "host-eight", number: 8, title: "Before" }));
      beforeBatch = (statements) => {
        if (
          !statements.some((s) =>
            s.sql.includes("INSERT OR IGNORE INTO publication_rollovers"),
          )
        )
          return;
        beforeBatch = undefined;
        if (change === "revision")
          sqlite.exec(
            "UPDATE episode_workspaces SET revision=revision+1 WHERE id='host-seven'",
          );
        if (change === "host choice" || change === "ABA") {
          sqlite.exec(
            "UPDATE episode_workspaces SET is_active=0 WHERE id='host-seven'; UPDATE episode_workspaces SET is_active=1 WHERE id='host-eight'",
          );
          if (change === "ABA")
            sqlite.exec(
              "UPDATE episode_workspaces SET is_active=0 WHERE id='host-eight'; UPDATE episode_workspaces SET is_active=1 WHERE id='host-seven'",
            );
        }
        if (change === "next contents")
          sqlite.exec(
            "UPDATE episode_workspaces SET data=json_set(data,'$.title','Edited concurrently'),revision=revision+1 WHERE id='host-eight'",
          );
        if (change === "catalog")
          sqlite.exec("UPDATE sync_state SET version=version+1 WHERE id=1");
      };
      vi.stubGlobal("fetch", responses());
      const status = await syncPublication(env);
      expect(status.latest?.guid).toBe("fiction-one");
      expect(status.lastSuccessAt).not.toBeNull();
      expect(status.lastError).toBeNull();
      expect(status.rollover.issue).toContain("skipped");
      expect(
        sqlite.prepare("SELECT rollover_issue FROM publication_sync").get(),
      ).toMatchObject({ rollover_issue: status.rollover.issue });
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
      ).toMatchObject({ n: 0 });
      expect(
        sqlite
          .prepare(
            "SELECT status FROM episode_workspaces WHERE id='host-seven'",
          )
          .get(),
      ).toMatchObject({ status: "draft" });
      expect(
        sqlite
          .prepare("SELECT id FROM episode_workspaces WHERE is_active=1")
          .get(),
      ).toMatchObject({
        id: change === "host choice" ? "host-eight" : "host-seven",
      });
      if (change === "next contents")
        expect(
          sqlite
            .prepare(
              "SELECT json_extract(data,'$.title') AS title FROM episode_workspaces WHERE id='host-eight'",
            )
            .get(),
        ).toMatchObject({ title: "Edited concurrently" });
    },
  );
  it("does not steal focus when an inactive or past episode is published", async () => {
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    sqlite.exec("UPDATE episode_workspaces SET is_active=0");
    sqlite
      .prepare(
        "INSERT INTO episode_workspaces(id,data,status,is_active) VALUES('newer',?,'draft',1)",
      )
      .run(JSON.stringify({ id: "newer", number: 9 }));
    vi.stubGlobal("fetch", responses());
    await syncPublication(env);
    expect(
      sqlite
        .prepare("SELECT id FROM episode_workspaces WHERE is_active=1")
        .get(),
    ).toMatchObject({ id: "newer" });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
    ).toMatchObject({ n: 0 });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM episode_workspaces").get(),
    ).toMatchObject({ n: 2 });
  });
  it("cannot reactivate a next workspace on receipt replay, even after host restoration", async () => {
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    vi.stubGlobal("fetch", responses());
    await syncPublication(env);
    sqlite.exec(
      "UPDATE episode_workspaces SET is_active=0; UPDATE episode_workspaces SET status='draft',is_active=1 WHERE id='host-seven'",
    );
    const before = sqlite
      .prepare("SELECT * FROM episode_workspaces ORDER BY id")
      .all();
    await syncPublication(env, { force: true });
    expect(
      sqlite.prepare("SELECT * FROM episode_workspaces ORDER BY id").all(),
    ).toEqual(before);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
    ).toMatchObject({ n: 1 });
  });
  it.each(["duplicate", "published", "imported only", "id collision"])(
    "surfaces ambiguous next draft: %s",
    async (kind) => {
      env.PUBLICATION_AUTO_ROLLOVER = "true";
      if (kind === "imported only")
        sqlite
          .prepare("INSERT INTO episodes(id,data) VALUES('eight',?)")
          .run(JSON.stringify({ id: "eight", number: 8 }));
      else {
        const id = kind === "id collision" ? "twib-8" : "eight";
        sqlite
          .prepare(
            "INSERT INTO episode_workspaces(id,data,status) VALUES(?,?,?)",
          )
          .run(
            id,
            JSON.stringify({ id, number: kind === "id collision" ? 9 : 8 }),
            kind === "published" ? "published" : "draft",
          );
        if (kind === "duplicate")
          sqlite
            .prepare(
              "INSERT INTO episode_workspaces(id,data,status) VALUES('other-eight',?,'draft')",
            )
            .run(JSON.stringify({ id: "other-eight", number: 8 }));
      }
      vi.stubGlobal("fetch", responses());
      expect((await syncPublication(env)).rollover.issue).toContain("skipped");
      expect(
        sqlite
          .prepare("SELECT id FROM episode_workspaces WHERE is_active=1")
          .get(),
      ).toMatchObject({ id: "host-seven" });
    },
  );
  it("rejects two distinct GUIDs advertising the same number in one feed", async () => {
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    const duplicate = feed().replace(
      "</channel>",
      feed(true, true, "second-guid").match(/<item>[\s\S]*<\/item>/)![0] +
        "</channel>",
    );
    const mock = responses();
    vi.stubGlobal("fetch", (url: string) =>
      url.includes("feed")
        ? Promise.resolve(new Response(duplicate))
        : mock(url),
    );
    const status = await syncPublication(env);
    expect(status.rollover.issue).toContain("ambiguous");
    expect(status.latest?.guid).toBe("fiction-one");
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
    ).toMatchObject({ n: 0 });
  });
  it("rejects conflicting historical GUIDs without losing metadata", async () => {
    vi.stubGlobal("fetch", responses());
    await syncPublication(env);
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    const mock = responses();
    vi.stubGlobal("fetch", (url: string) =>
      url.includes("feed")
        ? Promise.resolve(new Response(feed(true, true, "changed-guid")))
        : mock(url),
    );
    const status = await syncPublication(env, { force: true });
    expect(status.latest?.guid).toBe("changed-guid");
    expect(status.rollover.issue).toContain("identity conflicts");
    expect(
      sqlite
        .prepare("SELECT id FROM episode_workspaces WHERE is_active=1")
        .get(),
    ).toMatchObject({ id: "host-seven" });
  });
  it("does not roll over using a stale cached RSS after a failed refresh", async () => {
    vi.stubGlobal("fetch", responses());
    await syncPublication(env);
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    const mock = responses();
    vi.stubGlobal("fetch", (url: string) =>
      url.includes("feed")
        ? Promise.resolve(new Response("unavailable", { status: 503 }))
        : mock(url),
    );
    expect(
      (await syncPublication(env, { force: true })).rollover.issue,
    ).toContain("skipped");
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
    ).toMatchObject({ n: 0 });
  });
  it("treats an already published old episode as a benign no-op", async () => {
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    sqlite.exec(
      "UPDATE episode_workspaces SET is_active=0,status='published',data=json_set(data,'$.publishedGuid','fiction-one')",
    );
    sqlite
      .prepare(
        "INSERT INTO episode_workspaces(id,data,status,is_active) VALUES('host-eight',?,'draft',1)",
      )
      .run(
        JSON.stringify({
          id: "host-eight",
          number: 8,
          title: "Already active",
        }),
      );
    const before = sqlite
      .prepare("SELECT * FROM episode_workspaces ORDER BY id")
      .all();
    vi.stubGlobal("fetch", responses());
    const status = await syncPublication(env);
    expect(status.rollover).toEqual({
      enabled: true,
      issue: null,
      lastCompletedAt: null,
    });
    expect(
      sqlite.prepare("SELECT * FROM episode_workspaces ORDER BY id").all(),
    ).toEqual(before);
  });
  it("fences number ambiguity introduced after mapping without losing metadata", async () => {
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    beforeBatch = (statements) => {
      if (
        !statements.some((s) =>
          s.sql.includes("INSERT OR IGNORE INTO publication_rollovers"),
        )
      )
        return;
      beforeBatch = undefined;
      sqlite
        .prepare("INSERT INTO episodes(id,data) VALUES('collision',?)")
        .run(JSON.stringify({ id: "collision", number: 7 }));
    };
    vi.stubGlobal("fetch", responses());
    const status = await syncPublication(env);
    expect(status.latest?.guid).toBe("fiction-one");
    expect(status.rollover.issue).toContain("skipped");
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
    ).toMatchObject({ n: 0 });
  });
  it.each([7, 8])(
    "rejects imported number %s hidden by another workspace override",
    async (number) => {
      env.PUBLICATION_AUTO_ROLLOVER = "true";
      sqlite
        .prepare(
          "INSERT INTO episode_workspaces(id,data,status) VALUES('shadow',?,'draft')",
        )
        .run(JSON.stringify({ id: "shadow", number: 9 }));
      sqlite
        .prepare("INSERT INTO episodes(id,data) VALUES('shadow',?)")
        .run(JSON.stringify({ id: "shadow", number }));
      vi.stubGlobal("fetch", responses());
      const status = await syncPublication(env);
      expect(status.latest?.guid).toBe("fiction-one");
      expect(status.rollover.issue).toContain("skipped");
      expect(
        sqlite
          .prepare("SELECT id FROM episode_workspaces WHERE is_active=1")
          .get(),
      ).toMatchObject({ id: "host-seven" });
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
      ).toMatchObject({ n: 0 });
    },
  );
  it.each([7, 8])(
    "atomically fences hidden imported number %s changed after the read",
    async (number) => {
      env.PUBLICATION_AUTO_ROLLOVER = "true";
      sqlite
        .prepare(
          "INSERT INTO episode_workspaces(id,data,status) VALUES('shadow',?,'draft')",
        )
        .run(JSON.stringify({ id: "shadow", number: 9 }));
      sqlite
        .prepare("INSERT INTO episodes(id,data) VALUES('shadow',?)")
        .run(JSON.stringify({ id: "shadow", number: 9 }));
      beforeBatch = (statements) => {
        if (
          !statements.some((s) =>
            s.sql.includes("INSERT OR IGNORE INTO publication_rollovers"),
          )
        )
          return;
        beforeBatch = undefined;
        // Raw episode UPDATE has no catalog-version trigger: exercise the association guard independently.
        sqlite
          .prepare("UPDATE episodes SET data=? WHERE id='shadow'")
          .run(JSON.stringify({ id: "shadow", number }));
      };
      vi.stubGlobal("fetch", responses());
      const status = await syncPublication(env);
      expect(status.rollover.issue).toContain("skipped");
      expect(status.lastSuccessAt).not.toBeNull();
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
      ).toMatchObject({ n: 0 });
      expect(
        sqlite
          .prepare("SELECT id FROM episode_workspaces WHERE is_active=1")
          .get(),
      ).toMatchObject({ id: "host-seven" });
    },
  );
  it.each(["episodes", "episode_workspaces"])(
    "rejects GUID ownership claimed by a different raw %s record",
    async (table) => {
      env.PUBLICATION_AUTO_ROLLOVER = "true";
      const data = JSON.stringify({
        id: "already-published",
        number: 6,
        publishedGuid: "fiction-one",
      });
      if (table === "episodes") {
        sqlite
          .prepare(
            "INSERT INTO episodes(id,data) VALUES('already-published',?)",
          )
          .run(data);
        // The override hides the GUID, but does not erase its imported ownership.
        sqlite
          .prepare(
            "INSERT INTO episode_workspaces(id,data,status) VALUES('already-published',?,'published')",
          )
          .run(
            JSON.stringify({
              id: "already-published",
              number: 6,
              publishedGuid: null,
            }),
          );
      } else
        sqlite
          .prepare(
            "INSERT INTO episode_workspaces(id,data,status) VALUES('already-published',?,'published')",
          )
          .run(data);
      vi.stubGlobal("fetch", responses());
      const status = await syncPublication(env);
      expect(status.rollover.issue).toContain("skipped");
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
      ).toMatchObject({ n: 0 });
      expect(
        sqlite
          .prepare("SELECT id FROM episode_workspaces WHERE is_active=1")
          .get(),
      ).toMatchObject({ id: "host-seven" });
    },
  );
  it("atomically fences a raw imported GUID claim changed after mapping", async () => {
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    sqlite
      .prepare("INSERT INTO episodes(id,data) VALUES('already-published',?)")
      .run(
        JSON.stringify({
          id: "already-published",
          number: 6,
          publishedGuid: null,
        }),
      );
    beforeBatch = (statements) => {
      if (
        !statements.some((s) =>
          s.sql.includes("INSERT OR IGNORE INTO publication_rollovers"),
        )
      )
        return;
      beforeBatch = undefined;
      sqlite
        .prepare("UPDATE episodes SET data=? WHERE id='already-published'")
        .run(
          JSON.stringify({
            id: "already-published",
            number: 6,
            publishedGuid: "fiction-one",
          }),
        );
    };
    vi.stubGlobal("fetch", responses());
    const status = await syncPublication(env);
    expect(status.latest?.guid).toBe("fiction-one");
    expect(status.rollover.issue).toContain("skipped");
    expect(status.lastSuccessAt).not.toBeNull();
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM publication_rollovers").get(),
    ).toMatchObject({ n: 0 });
    expect(
      sqlite
        .prepare("SELECT id FROM episode_workspaces WHERE is_active=1")
        .get(),
    ).toMatchObject({ id: "host-seven" });
  });
  it("keeps rollover receipts immutable", async () => {
    env.PUBLICATION_AUTO_ROLLOVER = "true";
    vi.stubGlobal("fetch", responses());
    await syncPublication(env);
    expect(() => sqlite.exec("DELETE FROM publication_rollovers")).toThrow(
      "immutable publication rollover",
    );
    expect(() =>
      sqlite.exec("UPDATE publication_rollovers SET next_id='changed'"),
    ).toThrow("immutable publication rollover");
  });
  it("does not map an ambiguous episode number", async () => {
    sqlite
      .prepare("INSERT INTO episode_workspaces(id,data,status) VALUES(?,?,?)")
      .run(
        "duplicate",
        JSON.stringify({ id: "duplicate", number: 7 }),
        "draft",
      );
    vi.stubGlobal("fetch", responses());
    expect((await syncPublication(env)).latest?.episodeId).toBeNull();
  });
  it("honors Retry-After seconds across manual calls independently", async () => {
    const mock = responses();
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith(".srt")
        ? new Response("busy", {
            status: 429,
            headers: { "retry-after": "7200" },
          })
        : mock(url),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = await syncPublication(env);
    expect(Date.parse(first.assets.transcript.nextRetryAt!)).toBeGreaterThan(
      Date.now() + 7190000,
    );
    await syncPublication(env, { force: true });
    expect(
      fetcher.mock.calls.filter(([url]) => url.endsWith(".srt")),
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.filter(([url]) => url.endsWith(".json")),
    ).toHaveLength(2);
  });
  it("honors HTTP-date Retry-After and increases capped durable 5xx backoff", async () => {
    const date = new Date(Date.now() + 3 * 3600000).toUTCString();
    const mock = responses();
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith(".srt")
        ? new Response("busy", {
            status: 503,
            headers: { "retry-after": date },
          })
        : mock(url),
    );
    const first = await syncPublication(env);
    expect(first.assets.transcript.nextRetryAt).toBe(
      new Date(date).toISOString(),
    );
    sqlite.exec(
      "UPDATE publication_assets SET next_retry_at=0 WHERE kind='transcript'",
    );
    const second = await syncPublication(env, { force: true });
    expect(second.assets.transcript.failureCount).toBe(2);
  });
  it("does not steal an active lease, including forced refresh", async () => {
    sqlite
      .prepare(
        "UPDATE publication_sync SET lease_owner=?,lease_expires_at=? WHERE id=1",
      )
      .run("another-run", Date.now() + 60000);
    const mock = responses();
    vi.stubGlobal("fetch", mock);
    expect((await syncPublication(env, { force: true })).running).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });
  it("fences expired asset writes and preserves successor lease", async () => {
    vi.stubGlobal("fetch", async () => {
      sqlite
        .prepare(
          "UPDATE publication_sync SET lease_owner=?,lease_expires_at=? WHERE id=1",
        )
        .run("successor", Date.now() + 60000);
      return new Response(feed());
    });
    await syncPublication(env);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM publication_assets").get(),
    ).toMatchObject({ n: 0 });
    expect(
      sqlite.prepare("SELECT lease_owner FROM publication_sync").get(),
    ).toMatchObject({ lease_owner: "successor" });
  });
  it("accepts a realistic 750KB bounded RSS feed", () => {
    const large = feed().replace(
      "<channel>",
      "<channel><description>" + "x".repeat(750000) + "</description>",
    );
    expect(parseFeed(large)).toHaveLength(1);
  });
  it("retains original versions and changes edition fingerprint on transcript bytes", async () => {
    vi.stubGlobal("fetch", responses());
    const first = await syncPublication(env);
    const mock = responses();
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith(".srt")
        ? new Response(srt.replace("Fictional", "Changed"))
        : mock(url),
    );
    const second = await syncPublication(env, { force: true });
    expect(second.latest?.editionFingerprint).not.toBe(
      first.latest?.editionFingerprint,
    );
    expect(
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM publication_asset_versions WHERE kind='transcript'",
        )
        .get(),
    ).toMatchObject({ n: 2 });
  });
});

it("hourly due time tolerates delivery jitter instead of skipping the next cron", () => {
  const previous = Date.parse("2026-10-08T10:02:00.500Z");
  const next = Date.parse("2026-10-08T11:02:00.010Z");
  expect(nextPublicationCheck(previous)).toBeLessThanOrEqual(next);
  expect(nextPublicationCheck(previous)).toBe(
    Date.parse("2026-10-08T11:02:00.000Z"),
  );
});
