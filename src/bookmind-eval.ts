export interface EvalEnv {
  OPENAI_API_KEY: string;
  BOOKMIND_ENVIRONMENT_TEMPLATE_ID: string;
  OPENAI_AGENT_MODEL?: string;
  BOOKMIND_PLUGIN_VERSION?: string;
}

export interface EvalCase {
  test_id: string;
  suite: "GOLDEN" | "ADVERSARIAL" | "REGRESSION";
  prompt: string;
}

type Json = Record<string, unknown>;

const API_BASE = "https://api.openai.com/v1";

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function headers(env: EvalEnv): HeadersInit {
  return {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "agents=v1",
  };
}

async function openai(env: EvalEnv, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers(env), ...(init.headers || {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 1000)}`);
  }
  return data;
}

function findText(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) findText(v, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Json)) {
      if (["text", "output_text", "content", "value"].includes(k)) findText(v, out);
      else if (typeof v === "object") findText(v, out);
    }
  }
  return out;
}

async function waitForCompletion(env: EvalEnv, sessionId: string, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const session = await openai(env, `/agents/sessions/${sessionId}`);
    if (session.status === "idle" || session.status === "failed") return session;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(`Session ${sessionId} timed out after ${timeoutMs}ms`);
}

export async function runBookMindCase(env: EvalEnv, input: EvalCase) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  if (!env.BOOKMIND_ENVIRONMENT_TEMPLATE_ID) {
    throw new Error("BOOKMIND_ENVIRONMENT_TEMPLATE_ID is not configured");
  }
  if (!input.test_id || !input.prompt || !input.suite) {
    throw new Error("test_id, suite, and prompt are required");
  }

  const promptHash = await sha256(input.prompt);
  const pluginVersion = env.BOOKMIND_PLUGIN_VERSION || "0.8.3";
  const created = await openai(env, "/agents/sessions", {
    method: "POST",
    body: JSON.stringify({
      agent: {
        model: env.OPENAI_AGENT_MODEL || "gpt-6-astra",
        instructions:
          "Run the user request using the BookMind plugin loaded in this environment. Preserve evidence boundaries. Do not rewrite the user prompt.",
      },
      environment: {
        type: "openai_hosted",
        environment_template_id: env.BOOKMIND_ENVIRONMENT_TEMPLATE_ID,
      },
      input: input.prompt,
      metadata: {
        evaluator: "plugin-intelligence-mcp",
        test_id: input.test_id,
        suite: input.suite,
        plugin_version: pluginVersion,
        prompt_hash: promptHash,
      },
    }),
  });

  const sessionId = created.id as string;
  let finalSession: any;
  let items: any;
  try {
    finalSession = await waitForCompletion(env, sessionId);
    items = await openai(env, `/agents/sessions/${sessionId}/items?order=asc&limit=100`);
  } catch (error) {
    return {
      test_id: input.test_id,
      suite: input.suite,
      plugin_version: pluginVersion,
      prompt_original: input.prompt,
      prompt_hash: promptHash,
      prompt_rewritten: false,
      execution_status: "PARTIAL",
      session_id: sessionId,
      raw_answer: null,
      raw_items: null,
      selected_route: "NOT_OBSERVED",
      selected_skills: [],
      book_ids: [],
      node_ids: [],
      claim_ids: [],
      source_refs: [],
      evidence_levels: [],
      graph_edges: [],
      synthesis_labels: [],
      validation_flags: {},
      judge_verdict: "NOT_JUDGED",
      failure_reason: error instanceof Error ? error.message : String(error),
      root_cause: "runtime_session_failure",
    };
  }

  const textParts = findText(items);
  const rawAnswer = textParts.length ? textParts[textParts.length - 1] : "";

  return {
    test_id: input.test_id,
    suite: input.suite,
    plugin_version: pluginVersion,
    prompt_original: input.prompt,
    prompt_hash: promptHash,
    prompt_rewritten: false,
    execution_status: finalSession.status === "idle" ? "EXECUTED" : "PARTIAL",
    session_id: sessionId,
    raw_answer: rawAnswer,
    raw_items: items,
    selected_route: "NOT_OBSERVED",
    selected_skills: [],
    book_ids: [],
    node_ids: [],
    claim_ids: [],
    source_refs: [],
    evidence_levels: [],
    graph_edges: [],
    synthesis_labels: [],
    validation_flags: {},
    judge_verdict: "NOT_JUDGED",
    failure_reason: finalSession.status === "failed" ? "agent_session_failed" : null,
    root_cause: finalSession.status === "failed" ? "agents_api_runtime_failure" : null,
    usage: finalSession.usage || null,
  };
}

export async function runBookMindBatch(env: EvalEnv, tests: EvalCase[]) {
  if (!Array.isArray(tests) || tests.length === 0) throw new Error("tests[] is required");
  if (tests.length > 42) throw new Error("Maximum batch size is 42");

  const results = [];
  const concurrency = 3;
  for (let i = 0; i < tests.length; i += concurrency) {
    const chunk = tests.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map((test) => runBookMindCase(env, test)));
    results.push(...chunkResults);
  }

  return {
    requested: tests.length,
    executed: results.filter((r) => r.execution_status === "EXECUTED").length,
    partial: results.filter((r) => r.execution_status === "PARTIAL").length,
    results,
  };
}
