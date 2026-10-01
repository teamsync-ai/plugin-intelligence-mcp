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
    throw new Error(`${context} returned non-JSON response: ${text.slice(0, 500)}`);
  }
}

async function callAppsScript(
  env: Env,
  action: string,
  params: Record<string, string> = {},
) {
  if (!env.APPS_SCRIPT_URL) throw new Error("APPS_SCRIPT_URL is not configured");

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
  if (!env.APPS_SCRIPT_URL) throw new Error("APPS_SCRIPT_URL is not configured");

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

  return parseJsonResponse(response, `Apps Script POST ${action}`);
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "plugin-intelligence-mcp",
    version: "2.0.0",
  });

  // ---------- Legacy/read tools ----------

  server.registerTool(
    "get_plugins",
    {
      description: "Get plugin names, versions, and statuses.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await callAppsScript(env, "get_plugins")) }],
    }),
  );

  server.registerTool(
    "get_plugin_details",
    {
      description: "Get details for one plugin by name.",
      inputSchema: { plugin_name: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ plugin_name }) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await callAppsScript(env, "get_plugin_details", { plugin_name })),
      }],
    }),
  );

  server.registerTool(
    "get_golden_tests",
    {
      description: "Get Golden Tests, optionally filtered by plugin and version.",
      inputSchema: {
        plugin_name: z.string().min(1).optional(),
        version: z.union([z.string(), z.number()]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ plugin_name, version }) => {
      const params: Record<string, string> = {};
      if (plugin_name) params.plugin_name = plugin_name;
      if (version !== undefined) params.version = String(version);
      return {
        content: [{ type: "text", text: JSON.stringify(await callAppsScript(env, "get_golden_tests", params)) }],
      };
    },
  );

  server.registerTool(
    "get_test_history",
    {
      description: "Get persisted test-result history.",
      inputSchema: {
        plugin_name: z.string().min(1).optional(),
        version: z.union([z.string(), z.number()]).optional(),
        test_id: z.string().min(1).optional(),
        status: z.enum(["PASS", "FAIL", "PARTIAL", "NOT_EXECUTED"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ plugin_name, version, test_id, status }) => {
      const params: Record<string, string> = {};
      if (plugin_name) params.plugin_name = plugin_name;
      if (version !== undefined) params.version = String(version);
      if (test_id) params.test_id = test_id;
      if (status) params.status = status;
      return {
        content: [{ type: "text", text: JSON.stringify(await callAppsScript(env, "get_test_history", params)) }],
      };
    },
  );

  // ---------- Evaluation run lifecycle ----------

  server.registerTool(
    "create_evaluation_run",
    {
      description:
        "Create a versioned evaluation run before executing a Golden, Adversarial, Regression, or custom test suite.",
      inputSchema: {
        plugin: z.string().min(1),
        version: z.union([z.string(), z.number()]),
        suite: z.string().min(1),
        expected_test_count: z.number().int().nonnegative().optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await postAppsScript(env, "create_evaluation_run", input)),
      }],
    }),
  );

  server.registerTool(
    "save_runtime_test_result",
    {
      description:
        "Persist one runtime-evaluated test result with evidence, failure, regression, latency, tool-use, and provenance fields.",
      inputSchema: {
        run_id: z.string().min(1),
        test_id: z.string().min(1),
        plugin: z.string().min(1),
        version: z.union([z.string(), z.number()]),
        prompt: z.string().optional(),
        expected_route: z.string().optional(),
        expected_outcome: z.string().optional(),
        actual_route: z.string().optional(),
        actual_outcome: z.string().optional(),
        status: z.enum(["PASS", "FAIL", "PARTIAL", "NOT_EXECUTED"]),
        failure_reason: z.string().optional(),
        root_cause: z.string().optional(),
        evidence_level: z.string().optional(),
        source_refs: z.array(z.string()).optional(),
        unsupported_claim: z.boolean().optional(),
        fabricated_quote_page: z.boolean().optional(),
        false_full_text_verification: z.boolean().optional(),
        invented_graph_edge: z.boolean().optional(),
        unsupported_author_agreement: z.boolean().optional(),
        critical_failure: z.boolean().optional(),
        regression: z.boolean().optional(),
        latency_ms: z.number().nonnegative().optional(),
        tool_calls: z.number().int().nonnegative().optional(),
        repeatability_run: z.number().int().positive().optional(),
        raw_trace_ref: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await postAppsScript(env, "save_runtime_test_result", input)),
      }],
    }),
  );

  server.registerTool(
    "complete_evaluation_run",
    {
      description:
        "Finalize an evaluation run and compute evidence-backed run metrics without counting NOT_EXECUTED as PASS.",
      inputSchema: { run_id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ run_id }) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await postAppsScript(env, "complete_evaluation_run", { run_id })),
      }],
    }),
  );

  // ---------- Evaluation intelligence ----------

  server.registerTool(
    "get_run_summary",
    {
      description: "Get the computed metrics and metadata for one evaluation run.",
      inputSchema: { run_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ run_id }) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await callAppsScript(env, "get_run_summary", { run_id })),
      }],
    }),
  );

  server.registerTool(
    "get_failures",
    {
      description: "Get failed, partial, critical, or otherwise problematic test results.",
      inputSchema: {
        run_id: z.string().min(1).optional(),
        plugin_name: z.string().min(1).optional(),
        version: z.union([z.string(), z.number()]).optional(),
        critical_only: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ run_id, plugin_name, version, critical_only }) => {
      const params: Record<string, string> = {};
      if (run_id) params.run_id = run_id;
      if (plugin_name) params.plugin_name = plugin_name;
      if (version !== undefined) params.version = String(version);
      if (critical_only !== undefined) params.critical_only = String(critical_only);
      return {
        content: [{ type: "text", text: JSON.stringify(await callAppsScript(env, "get_failures", params)) }],
      };
    },
  );

  server.registerTool(
    "get_regressions",
    {
      description: "Get persisted regression results for a run, plugin, or version.",
      inputSchema: {
        run_id: z.string().min(1).optional(),
        plugin_name: z.string().min(1).optional(),
        version: z.union([z.string(), z.number()]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ run_id, plugin_name, version }) => {
      const params: Record<string, string> = {};
      if (run_id) params.run_id = run_id;
      if (plugin_name) params.plugin_name = plugin_name;
      if (version !== undefined) params.version = String(version);
      return {
        content: [{ type: "text", text: JSON.stringify(await callAppsScript(env, "get_regressions", params)) }],
      };
    },
  );

  server.registerTool(
    "build_evidence_pack",
    {
      description:
        "Build an evidence pack for one evaluation run, including metrics, failures, regressions, critical failures, and result records.",
      inputSchema: { run_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ run_id }) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await callAppsScript(env, "build_evidence_pack", { run_id })),
      }],
    }),
  );

  server.registerTool(
    "release_gate_v2",
    {
      description:
        "Evaluate release readiness from one completed evaluation run. Critical failures, unsupported claims, regressions, incomplete execution, and evidence gaps can block release.",
      inputSchema: { run_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ run_id }) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await callAppsScript(env, "release_gate_v2_data", { run_id })),
      }],
    }),
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        ok: true,
        service: "plugin-intelligence-mcp",
        version: "2.0.0",
        mcp_endpoint: "/mcp",
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
