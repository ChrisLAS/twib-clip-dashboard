import type { Env } from "../env";
import { HttpError, json } from "../errors";
import { authenticateInventory, INVENTORY_INGEST_PATH } from "./auth";
import { readInventoryBody } from "./contract";
import { acceptInventory } from "./store";

export async function ingestInventory(
  request: Request,
  env: Env,
): Promise<Response> {
  if (new URL(request.url).pathname !== INVENTORY_INGEST_PATH)
    throw new HttpError(
      503,
      "INVENTORY_INGESTION_DISABLED",
      "Inventory ingestion is not activated.",
    );
  // Verify configuration, identity and fixed grant before consuming any body.
  const grant = await authenticateInventory(request, env);
  const input = await readInventoryBody(request);
  // Validation (including exact source/episode and empty origins/context) precedes
  // every DB read/write. Durable commit/readback precedes the only success reply.
  const receipt = await acceptInventory(
    env.DB,
    input,
    request.headers.get("Idempotency-Key"),
    grant,
  );
  return json(receipt, 200);
}
