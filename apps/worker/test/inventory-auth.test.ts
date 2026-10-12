import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { InventoryEnvelope } from "../src/inventory/contract";
const state = vi.hoisted(() => ({
  key: undefined as CryptoKey | undefined,
  failure: undefined as Error | undefined,
}));
vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => async () => {
      if (state.failure) throw state.failure;
      return state.key;
    }),
  };
});
const now = Date.parse("2026-10-13T12:00:00Z");
const seconds = now / 1000;
const endpoint =
  "https://inventory.example.com/api/v2/number-one/inventory-snapshots";
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let env: Env;
let db: D1Database;
let sqlite: DatabaseSync;
let envelope: InventoryEnvelope;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  state.key = pair.publicKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
});
class Statement {
  values: (string | number | null)[] = [];
  constructor(private sql: string) {}
  bind(...values: (string | number | null)[]) {
    this.values = values;
    return this;
  }
  async first() {
    return sqlite.prepare(this.sql).get(...this.values) ?? null;
  }
  async all() {
    return { results: sqlite.prepare(this.sql).all(...this.values) };
  }
  async run() {
    return sqlite.prepare(this.sql).run(...this.values);
  }
}
beforeEach(() => {
  state.failure = undefined;
  vi.spyOn(Date, "now").mockReturnValue(now);
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  db = {
    prepare: vi.fn((sql: string) => new Statement(sql)),
    batch: vi.fn(async (rows: Statement[]) => {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const row of rows) result.push(await row.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    }),
  } as unknown as D1Database;
  env = {
    DB: db,
    APP_ENV: "production",
    ACCESS_AUD: "b".repeat(64),
    INVENTORY_INGEST_ENABLED: "true",
    INVENTORY_APP_ORIGIN: "https://inventory.example.com",
    INVENTORY_ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
    INVENTORY_ACCESS_AUD: "a".repeat(64),
    INVENTORY_ACCESS_CLIENT_ID: "synthetic-client.access",
    INVENTORY_GRANT_STARTS_AT: new Date(now - 60000).toISOString(),
    INVENTORY_GRANT_EXPIRES_AT: new Date(now + 3600000).toISOString(),
  };
  envelope = JSON.parse(
    readFileSync(
      new URL("./fixtures/inventory.envelope.example.json", import.meta.url),
      "utf8",
    ),
  );
  for (const item of envelope.manifest.items) {
    item.origins = [];
    for (const o of item.observations) o.context = {};
  }
  envelope.manifest.snapshot.complete = false;
});
async function token(changes: JWTPayload = {}, key = privateKey) {
  return new SignJWT({
    iss: "https://synthetic.cloudflareaccess.com",
    aud: ["a".repeat(64)],
    iat: seconds,
    exp: seconds + 900,
    type: "app",
    common_name: "synthetic-client.access",
    sub: "",
    ...changes,
  })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic" })
    .sign(key);
}
function request(jwt?: string, url = endpoint, method = "POST") {
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": envelope.scan_id,
      ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(envelope) } : {}),
  });
}
async function denied(req: Request, status: number) {
  const response = await worker.fetch(req, env);
  expect(response.status).toBe(status);
  expect(db.prepare).not.toHaveBeenCalled();
  expect(db.batch).not.toHaveBeenCalled();
  expect((await response.text()).length).toBeLessThan(512);
}
describe("disabled-by-default inventory machine authentication", () => {
  it.each([
    "INVENTORY_INGEST_ENABLED",
    "INVENTORY_APP_ORIGIN",
    "INVENTORY_ACCESS_TEAM_DOMAIN",
    "INVENTORY_ACCESS_AUD",
    "INVENTORY_ACCESS_CLIENT_ID",
    "INVENTORY_GRANT_STARTS_AT",
    "INVENTORY_GRANT_EXPIRES_AT",
    "ACCESS_AUD",
  ] as const)("missing %s stays closed", async (field) => {
    delete env[field];
    await denied(request(), 503);
  });
  it.each([
    ["INVENTORY_APP_ORIGIN", "http://inventory.example.com"],
    ["INVENTORY_APP_ORIGIN", "https://inventory.example.com/path"],
    ["INVENTORY_ACCESS_TEAM_DOMAIN", "attacker.example.com"],
    ["INVENTORY_ACCESS_AUD", "b".repeat(64)],
    ["INVENTORY_GRANT_EXPIRES_AT", new Date(now + 86400000).toISOString()],
  ])("invalid config %s=%s stays closed", async (field, value) => {
    (env as unknown as Record<string, string>)[field] = value;
    await denied(request(), 503);
  });
  it("expired fixed grant fails before body consumption", async () => {
    env.INVENTORY_GRANT_EXPIRES_AT = new Date(now).toISOString();
    const req = request(await token());
    await denied(req, 403);
    expect(req.bodyUsed).toBe(false);
  });
  it("future fixed grant fails closed", async () => {
    env.INVENTORY_GRANT_STARTS_AT = new Date(now + 1000).toISOString();
    await denied(request(await token()), 403);
  });
  it("raw Access headers, cookie and owner email cannot substitute for signed assertion", async () => {
    const req = request();
    req.headers.set("CF-Access-Client-Id", "synthetic-client.access");
    req.headers.set("CF-Access-Client-Secret", "offline-dummy");
    req.headers.set("Cookie", "CF_Authorization=offline-dummy");
    req.headers.set("Cf-Access-Authenticated-User-Email", "owner@example.com");
    await denied(req, 401);
    expect(req.bodyUsed).toBe(false);
  });
  it("rejects invalid signature", async () =>
    denied(request(await token({}, otherKey)), 401));
  it("rejects malformed assertion", async () =>
    denied(request("not.a.jwt"), 401));
  it.each([
    { iss: "https://wrong.cloudflareaccess.com" },
    { aud: ["b".repeat(64)] },
    { aud: ["a".repeat(64), "b".repeat(64)] },
    { type: "org" },
    { common_name: "other.access" },
    { sub: "owner" },
    { email: "owner@example.com" },
    { exp: seconds },
    { iat: seconds + 61 },
    { iat: seconds - 901 },
    { exp: seconds + 3601 },
    { nbf: seconds + 61 },
    { iat: undefined },
    { exp: undefined },
    { common_name: undefined },
    { sub: undefined },
  ])("rejects wrong signed claims %j", async (changes) =>
    denied(request(await token(changes)), 401),
  );
  it.each([
    endpoint + "?anything=1",
    endpoint.replace("inventory.example.com", "other.example.com"),
  ])("rejects wrong destination %s", async (url) =>
    denied(request(await token(), url), 401),
  );
  it("rejects non-POST", async () =>
    denied(request(await token(), endpoint, "GET"), 401));
  it("keeps sibling/v1 namespaces disabled", async () =>
    denied(request(await token(), endpoint.replace("v2", "v1")), 503));
  it("wrong source/episode grant does not touch DB", async () => {
    envelope.manifest.episode.number = 128;
    await denied(request(await token()), 403);
  });
  it("unprojected origins do not touch DB", async () => {
    envelope.manifest.items[0].origins = [
      { id: `origin_${"a".repeat(64)}`, url: "https://example.com/story" },
    ];
    await denied(request(await token()), 422);
  });
  it("unprojected prose does not touch DB", async () => {
    envelope.manifest.items[0].observations[0].context = {
      title: "Synthetic note",
    };
    await denied(request(await token()), 422);
  });
  it("authenticates before oversized body rejection", async () => {
    const req = request(await token());
    req.headers.set("Content-Length", "1048577");
    await denied(req, 413);
  });
  it("commits before bounded success receipt and exact replay", async () => {
    const jwt = await token();
    const response = await worker.fetch(request(jwt), env);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.length).toBeLessThan(4096);
    const receipt = JSON.parse(text);
    expect(receipt.scan_id).toBe(envelope.scan_id);
    expect(receipt.sequence).toBe(envelope.sequence);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_snapshots").get()
        ?.count,
    ).toBe(1);
    const replay = await worker.fetch(request(jwt), env);
    expect(await replay.json()).toEqual(receipt);
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("database failure returns no receipt", async () => {
    vi.mocked(db.batch).mockRejectedValue(new Error("synthetic DB failure"));
    const response = await worker.fetch(request(await token()), env);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("receipt_id");
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_snapshots").get()
        ?.count,
    ).toBe(0);
  });
  it("machine JWT does not bypass owner route", async () => {
    env.APP_ORIGIN = "https://inventory.example.com";
    env.ACCESS_TEAM_DOMAIN = "synthetic.cloudflareaccess.com";
    env.OWNER_EMAIL = "owner@example.com";
    await denied(
      new Request(
        "https://inventory.example.com/api/inventory?episodeId=" +
          envelope.manifest.episode.id,
        { headers: { "Cf-Access-Jwt-Assertion": await token() } },
      ),
      401,
    );
  });
});

describe("bounded inventory authentication diagnostics", () => {
  async function diagnostic(
    jwt: string | undefined,
    category: string,
    url = endpoint,
  ) {
    const req = request(jwt, url);
    const response = await worker.fetch(req, env);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const text = await response.text();
    expect(text.length).toBeLessThan(256);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "INVENTORY_AUTH_REQUIRED",
        message: "A valid inventory machine identity is required.",
        category,
      },
    });
    if (jwt) expect(text).not.toContain(jwt);
    expect(text).not.toContain("SYNTHETIC_PRIVATE_CANARY");
    expect(text).not.toContain("synthetic-client.access");
    expect(text).not.toContain("payload");
    expect(req.bodyUsed).toBe(false);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  }
  it("missing assertion", async () =>
    diagnostic(undefined, "assertion_missing"));
  it("malformed assertion", async () =>
    diagnostic("SYNTHETIC_PRIVATE_CANARY", "assertion_shape"));
  it("oversized assertion", async () =>
    diagnostic("x".repeat(16385), "assertion_shape"));
  it("wrong destination", async () =>
    diagnostic(
      await token(),
      "request_scope",
      endpoint + "?SYNTHETIC_PRIVATE_CANARY=1",
    ));
  it("signature failure", async () =>
    diagnostic(
      await token({ canary: "SYNTHETIC_PRIVATE_CANARY" }, otherKey),
      "signature",
    ));
  it("key-fetch exceptions cannot leak message or payload", async () => {
    state.failure = Object.assign(new Error("SYNTHETIC_PRIVATE_CANARY"), {
      payload: { secret: "SYNTHETIC_PRIVATE_CANARY" },
    });
    await diagnostic(await token(), "jwks_unavailable");
  });
  it.each([
    [{ iss: "https://SYNTHETIC_PRIVATE_CANARY.example" }, "issuer"],
    [{ aud: ["SYNTHETIC_PRIVATE_CANARY"] }, "audience"],
    [{ aud: ["a".repeat(64), "SYNTHETIC_PRIVATE_CANARY"] }, "audience"],
    [{ aud: "a".repeat(64) }, "audience"],
    [{ exp: seconds }, "expiry"],
    [{ nbf: seconds + 61 }, "expiry"],
    [{ type: "org" }, "service_identity"],
    [{ common_name: "SYNTHETIC_PRIVATE_CANARY" }, "service_identity"],
    [{ sub: "SYNTHETIC_PRIVATE_CANARY" }, "service_identity"],
    [{ email: "SYNTHETIC_PRIVATE_CANARY" }, "service_identity"],
    [{ iat: seconds + 61 }, "issued_at"],
    [{ iat: seconds - 901 }, "issued_at"],
    [{ exp: seconds + 3601 }, "token_lifetime"],
    [{ iat: seconds + 60, exp: seconds + 30 }, "token_lifetime"],
    [{ iat: seconds + 0.5 }, "assertion_shape"],
    [{ common_name: undefined }, "assertion_shape"],
  ] as [JWTPayload, string][])(
    "fixed category for signed claim rejection %j",
    async (claims, category) => {
      await diagnostic(
        await token({ ...claims, canary: "SYNTHETIC_PRIVATE_CANARY" }),
        category,
      );
    },
  );
});
