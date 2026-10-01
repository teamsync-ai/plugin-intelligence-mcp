import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  APPS_SCRIPT_URL: string;
}

async function callAppsScript(
  env: Env,
  action: string,
  params: Record<string, string> = {},
) {
  if (!env.APPS_SCRIPT_URL) {
    throw new Error("APPS_SCRIPT_URL is not configured");
  }

  const url = new URL(env.APPS_SCRIPT_URL);
  url.searchParams.set("action", action);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Apps Script returned HTTP ${response.status}`);
  }

  return response.json();
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "plugin-intelligence-mcp",
    version: "1.1.0",
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
      const data = await callAppsScript(env, "get_plugins");

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

  server.registerTool(
    "get_plugin_details",
    {
      description:
        "Get details for one plugin by plugin name from the Google Sheet backend.",
      inputSchema: {
        plugin_name: z
          .string()
          .min(1)
          .describe("Exact plugin name, for example UGC Market Commander"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ plugin_name }) => {
      const data = await callAppsScript(env, "get_plugin_details", {
        plugin_name,
      });

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
        version: "1.1.0",
        mcp_endpoint: "/mcp",
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
