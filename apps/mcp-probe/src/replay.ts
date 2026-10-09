import { DurableObject } from "cloudflare:workers";

/** Strongly consistent one-time markers supplement the provider's eventual KV. */
export class ReplayGuard extends DurableObject<Env> {
  async claim(key: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid marker");
    const accepted = await this.ctx.storage.transaction(async (txn) => {
      if (await txn.get(key)) {
        await txn.put("revoked", true);
        return false;
      }
      await txn.put(key, true);
      return true;
    });
    // One object per opaque marker; no raw codes or identities are stored here.
    if (accepted) await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
    return accepted;
  }
  async revoked(): Promise<boolean> {
    return Boolean(await this.ctx.storage.get("revoked"));
  }
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export async function markerKey(kind: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${kind}:${value}`),
  );
  const key = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return key;
}
export async function claimOnce(
  env: Env,
  kind: string,
  value: string,
): Promise<boolean> {
  const key = await markerKey(kind, value);
  return env.REPLAY_GUARD.getByName(key).claim(key);
}
