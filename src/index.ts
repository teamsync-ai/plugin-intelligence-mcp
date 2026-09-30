import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

interface Env {
  APPS_SCRIPT_URL: string;
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "plugin-intelligence-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "get_plugins",
    {
      description:
        "Get the current plugin names, versions, and statuses from the Google Sheet backend.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      if (!env.APPS_SCRIPT_URL) {
        throw new Error("APPS_SCRIPT_URL is not configured");
      }

      const url = new URL(env.APPS_SCRIPT_URL);
      url.searchParams.set("action", "get_plugins");

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Apps Script returned HTTP ${response.status}`);
      }

      const data = await response.json();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data),
          },
        ],
      };
    },
  );

  return server;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        ok: true,
        service: "plugin-intelligence-mcp",
        version: "1.0.0",
        mcp_endpoint: "/mcp",
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
