import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  APPS_SCRIPT_URL: string;
}

async function parseJsonResponse(response: Response, context: string) {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${context} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${context} returned non-JSON response: ${text.slice(0, 500)}`,
    );
  }
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
    headers: { Accept: "application/json" },
  });

  return parseJsonResponse(response, `Apps Script GET ${action}`);
}

async function postAppsScript(
  env: Env,
  action: string,
  payload: Record<string, unknown>,
) {
  if (!env.APPS_SCRIPT_URL) {
    throw new Error("APPS_SCRIPT_URL is not configured");
  }

  const url = new URL(env.APPS_SCRIPT_URL);
  url.searchParams.set("action", action);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const contentType = response.headers.get("content-type") ?? "unknown";
  const finalUrl = response.url;
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Apps Script POST ${action} returned HTTP ${response.status}; content-type=${contentType}; final-url=${finalUrl}; body=${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Apps Script POST ${action} returned non-JSON; content-type=${contentType}; final-url=${finalUrl}; body=${text.slice(0, 500)}`,
    );
  }
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "plugin-intelligence-mcp",
    version: "1.3.2",
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
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await callAppsScript(env, "get_plugins")),
        },
      ],
    }),
  );

  server.registerTool(
    "get_plugin_details",
    {
      description:
        "Get details for one plugin by plugin name from the Google Sheet backend.",
      inputSchema: {
        plugin_name: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ plugin_name }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await callAppsScript(env, "get_plugin_details", { plugin_name }),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "get_golden_tests",
    {
      description:
        "Get Golden Test cases, optionally filtered by plugin name and version.",
      inputSchema: {
        plugin_name: z.string().min(1).optional(),
        version: z.union([z.string(), z.number()]).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ plugin_name, version }) => {
      const params: Record<string, string> = {};
      if (plugin_name) params.plugin_name = plugin_name;
      if (version !== undefined) params.version = String(version);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await callAppsScript(env, "get_golden_tests", params),
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "save_test_result",
    {
      description:
        "Persist one executed Golden Test result to the Google Sheet evidence store.",
      inputSchema: {
        test_id: z.string().min(1),
        plugin: z.string().min(1),
        version: z.union([z.string(), z.number()]),
        actual_route: z.string().min(1),
        actual_outcome: z.string().min(1),
        status: z.enum(["PASS", "FAIL", "PARTIAL"]),
        failure_reason: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      test_id,
      plugin,
      version,
      actual_route,
      actual_outcome,
      status,
      failure_reason,
    }) => {
      const data = await postAppsScript(env, "save_test_result", {
        test_id,
        plugin,
        version,
        actual_route,
        actual_outcome,
        status,
        failure_reason: failure_reason ?? "",
      });

      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
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
        version: "1.3.2",
        mcp_endpoint: "/mcp",
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
