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

function latestByTestId(results: any[]) {
  const map = new Map<string, any>();

  for (const row of results ?? []) {
    const key = String(row.test_id ?? "");
    if (!key) continue;

    const current = map.get(key);
    const rowTime = Date.parse(String(row.executed_at ?? "")) || 0;
    const currentTime = current
      ? Date.parse(String(current.executed_at ?? "")) || 0
      : -1;

    if (!current || rowTime >= currentTime) {
      map.set(key, row);
    }
  }

  return map;
}

function summarizeResults(results: any[]) {
  const latest = [...latestByTestId(results).values()];
  const counts = { PASS: 0, FAIL: 0, PARTIAL: 0 };

  for (const row of latest) {
    const status = String(row.status ?? "").toUpperCase();
    if (status === "PASS" || status === "FAIL" || status === "PARTIAL") {
      counts[status]++;
    }
  }

  const total = latest.length;

  return {
    executed_test_count: total,
    pass_count: counts.PASS,
    fail_count: counts.FAIL,
    partial_count: counts.PARTIAL,
    pass_rate: total ? Number(((counts.PASS / total) * 100).toFixed(2)) : 0,
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "plugin-intelligence-mcp",
    version: "1.4.0",
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

  server.registerTool(
    "get_test_history",
    {
      description:
        "Get persisted test-result history, optionally filtered by plugin, version, test id, or status.",
      inputSchema: {
        plugin_name: z.string().min(1).optional(),
        version: z.union([z.string(), z.number()]).optional(),
        test_id: z.string().min(1).optional(),
        status: z.enum(["PASS", "FAIL", "PARTIAL"]).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ plugin_name, version, test_id, status }) => {
      const params: Record<string, string> = {};
      if (plugin_name) params.plugin_name = plugin_name;
      if (version !== undefined) params.version = String(version);
      if (test_id) params.test_id = test_id;
      if (status) params.status = status;

      const data = await callAppsScript(env, "get_test_history", params);

      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
      };
    },
  );

  server.registerTool(
    "compare_versions",
    {
      description:
        "Compare the latest persisted test results for two versions of the same plugin, including pass rates, regressions, and improvements.",
      inputSchema: {
        plugin_name: z.string().min(1),
        version_a: z.union([z.string(), z.number()]),
        version_b: z.union([z.string(), z.number()]),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ plugin_name, version_a, version_b }) => {
      const [a, b] = await Promise.all([
        callAppsScript(env, "get_test_history", {
          plugin_name,
          version: String(version_a),
        }),
        callAppsScript(env, "get_test_history", {
          plugin_name,
          version: String(version_b),
        }),
      ]);

      const resultsA = Array.isArray(a.results) ? a.results : [];
      const resultsB = Array.isArray(b.results) ? b.results : [];

      const mapA = latestByTestId(resultsA);
      const mapB = latestByTestId(resultsB);

      const commonIds = [...mapA.keys()].filter((id) => mapB.has(id));
      const regressions: any[] = [];
      const improvements: any[] = [];
      const unchanged: any[] = [];

      for (const testId of commonIds) {
        const rowA = mapA.get(testId);
        const rowB = mapB.get(testId);
        const statusA = String(rowA?.status ?? "");
        const statusB = String(rowB?.status ?? "");

        const item = {
          test_id: testId,
          from: statusA,
          to: statusB,
        };

        if (statusA === "PASS" && statusB !== "PASS") {
          regressions.push(item);
        } else if (statusA !== "PASS" && statusB === "PASS") {
          improvements.push(item);
        } else {
          unchanged.push(item);
        }
      }

      const data = {
        ok: true,
        plugin: plugin_name,
        version_a,
        version_b,
        version_a_summary: summarizeResults(resultsA),
        version_b_summary: summarizeResults(resultsB),
        comparable_test_count: commonIds.length,
        regression_count: regressions.length,
        improvement_count: improvements.length,
        regressions,
        improvements,
        unchanged,
        comparison_note:
          "Comparison uses the latest persisted result for each shared test_id in each version.",
      };

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
        version: "1.4.0",
        mcp_endpoint: "/mcp",
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
