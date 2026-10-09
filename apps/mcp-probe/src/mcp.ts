import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export const SCOPE = "integration:status";
export async function serveMcp(request: Request, env: Env): Promise<Response> {
  const server = new McpServer({
    name: "twib-integration-probe",
    version: env.APP_VERSION,
  });
  server.registerTool(
    "get_integration_status",
    {
      title: "Check TWiB integration connection",
      description:
        "Returns this isolated probe's version, opaque owner ID and a fresh nonce. Does not access clips, media, reviews or jobs.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        app_version: z.string(),
        owner_id: z.string(),
        nonce: z.string().uuid(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [SCOPE] }] },
    },
    async () => {
      const status = {
        app_version: env.APP_VERSION,
        owner_id: env.OWNER_OPAQUE_ID,
        nonce: crypto.randomUUID(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
        structuredContent: status,
      };
    },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
