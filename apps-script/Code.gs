/**
 * Plugin Intelligence MCP Backend v2
 * Google Apps Script
 *
 * Required sheets:
 * plugins
 * golden_tests
 * test_results          (legacy compatibility)
 * evaluation_runs
 * runtime_results
 */

const CONFIG = {
  SHEETS: {
    PLUGINS: "plugins",
    GOLDEN_TESTS: "golden_tests",
    TEST_RESULTS: "test_results",
    EVALUATION_RUNS: "evaluation_runs",
    RUNTIME_RESULTS: "runtime_results"
  },
  RELEASE_GATE_V2: {
    MIN_PASS_RATE: 90,
    MIN_EVIDENCE_VERIFIED_RATE: 90,
    MAX_CRITICAL_FAILURES: 0,
    MAX_UNSUPPORTED_CLAIMS: 0,
    MAX_REGRESSIONS: 0,
    MAX_NOT_EXECUTED: 0
  }
};

function doGet(e) {
  try {
    const p = e && e.parameter ? e.parameter : {};
    const action = String(p.action || "").trim();

    switch (action) {
      case "health":
        return jsonResponse(health());
      case "get_plugins":
        return jsonResponse(getPluginsData());
      case "get_plugin_details":
        return jsonResponse(getPluginDetailsData(p.plugin_name));
      case "get_golden_tests":
        return jsonResponse(getGoldenTestsData(p.plugin_name, p.version));
      case "get_test_history":
        return jsonResponse(getLegacyTestHistoryData(p.plugin_name, p.version, p.test_id, p.status));
      case "get_run_summary":
        return jsonResponse(getRunSummaryData(p.run_id));
      case "get_failures":
        return jsonResponse(getFailuresData(p));
      case "get_regressions":
        return jsonResponse(getRegressionsData(p));
      case "build_evidence_pack":
        return jsonResponse(buildEvidencePackData(p.run_id));
      case "release_gate_v2_data":
        return jsonResponse(releaseGateV2Data(p.run_id));
      default:
        return jsonResponse({ ok: false, error: "Unknown GET action", action: action || null });
    }
  } catch (err) {
    return jsonError(err, "doGet");
  }
}

function doPost(e) {
  try {
    const p = e && e.parameter ? e.parameter : {};
    const action = String(p.action || "").trim();

    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: "POST body is required" });
    }

    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonResponse({ ok: false, error: "Invalid JSON body", details: String(err) });
    }

    switch (action) {
      case "save_test_result":
        return jsonResponse(saveLegacyTestResultData(body));
      case "create_evaluation_run":
        return jsonResponse(createEvaluationRunData(body));
      case "save_runtime_test_result":
        return jsonResponse(saveRuntimeTestResultData(body));
      case "complete_evaluation_run":
        return jsonResponse(completeEvaluationRunData(body.run_id));
      default:
        return jsonResponse({ ok: false, error: "Unknown POST action", action: action || null });
    }
  } catch (err) {
    return jsonError(err, "doPost");
  }
}

function health() {
  return {
    ok: true,
    service: "plugin-intelligence-backend",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    sheets: {
      plugins: sheetExists(CONFIG.SHEETS.PLUGINS),
      golden_tests: sheetExists(CONFIG.SHEETS.GOLDEN_TESTS),
      test_results: sheetExists(CONFIG.SHEETS.TEST_RESULTS),
      evaluation_runs: sheetExists(CONFIG.SHEETS.EVALUATION_RUNS),
      runtime_results: sheetExists(CONFIG.SHEETS.RUNTIME_RESULTS)
    }
  };
}

/* ---------------- Plugins ---------------- */

function getPluginsData() {
  const rows = dataRows(CONFIG.SHEETS.PLUGINS);
  return {
    ok: true,
    count: rows.length,
    plugins: rows.filter(r => r[0]).map(r => ({
      plugin: r[0],
      version: r[1],
      status: r[2]
    }))
  };
}

function getPluginDetailsData(pluginName) {
  requireValue(pluginName, "plugin_name");
  const target = normalizeText(pluginName);
  const row = dataRows(CONFIG.SHEETS.PLUGINS)
    .find(r => normalizeText(r[0]) === target);

  if (!row) return { ok: false, error: "Plugin not found", plugin_name: pluginName };

  return {
    ok: true,
    plugin: { plugin: row[0], version: row[1], status: row[2] }
  };
}

/* ---------------- Golden Tests ---------------- */

function getGoldenTestsData(pluginName, version) {
  let rows = dataRows(CONFIG.SHEETS.GOLDEN_TESTS).filter(r => r[0]);

  if (pluginName) {
    const target = normalizeText(pluginName);
    rows = rows.filter(r => normalizeText(r[1]) === target);
  }

  if (hasValue(version)) {
    rows = rows.filter(r => String(r[2]).trim() === String(version).trim());
  }

  const tests = rows.map(r => ({
    test_id: r[0],
    plugin: r[1],
    version: r[2],
    prompt: r[3],
    expected_route: r[4],
    expected_outcome: r[5],
    status: r[6]
  }));

  return { ok: true, count: tests.length, tests };
}

/* ---------------- Legacy compatibility ---------------- */

function saveLegacyTestResultData(data) {
  ["test_id","plugin","version","actual_route","actual_outcome","status"]
    .forEach(k => requireValue(data[k], k));

  const status = normalizeStatus(data.status);
  if (!["PASS","FAIL","PARTIAL"].includes(status)) {
    throw new Error("status must be PASS, FAIL, or PARTIAL");
  }

  const now = new Date();
  const resultId = makeId("RESULT");

  getSheetOrThrow(CONFIG.SHEETS.TEST_RESULTS).appendRow([
    resultId,
    data.test_id,
    data.plugin,
    data.version,
    data.actual_route,
    data.actual_outcome,
    status,
    data.failure_reason || "",
    now
  ]);

  return {
    ok: true,
    saved: true,
    result_id: resultId,
    test_id: data.test_id,
    plugin: data.plugin,
    version: data.version,
    status,
    executed_at: now.toISOString()
  };
}

function getLegacyTestHistoryData(pluginName, version, testId, status) {
  let rows = dataRows(CONFIG.SHEETS.TEST_RESULTS).filter(r => r[0]);

  if (pluginName) {
    const target = normalizeText(pluginName);
    rows = rows.filter(r => normalizeText(r[2]) === target);
  }
  if (hasValue(version)) {
    rows = rows.filter(r => String(r[3]).trim() === String(version).trim());
  }
  if (testId) rows = rows.filter(r => String(r[1]).trim() === String(testId).trim());
  if (status) rows = rows.filter(r => normalizeStatus(r[6]) === normalizeStatus(status));

  const results = rows.map(r => ({
    result_id: r[0],
    test_id: r[1],
    plugin: r[2],
    version: r[3],
    actual_route: r[4],
    actual_outcome: r[5],
    status: r[6],
    failure_reason: r[7],
    executed_at: serializeDate(r[8])
  }));

  return { ok: true, count: results.length, results };
}

/* ---------------- Evaluation Run lifecycle ---------------- */

function createEvaluationRunData(data) {
  ["plugin","version","suite"].forEach(k => requireValue(data[k], k));

  const now = new Date();
  const runId = makeId("RUN");
  const expected = numberOrZero(data.expected_test_count);

  getSheetOrThrow(CONFIG.SHEETS.EVALUATION_RUNS).appendRow([
    runId,                 // A run_id
    data.plugin,           // B plugin
    data.version,          // C version
    data.suite,            // D suite
    expected,              // E expected_test_count
    "RUNNING",             // F status
    data.notes || "",      // G notes
    now,                   // H started_at
    "",                    // I completed_at
    0,                     // J executed_count
    0,                     // K pass_count
    0,                     // L fail_count
    0,                     // M partial_count
    0,                     // N not_executed_count
    0,                     // O pass_rate
    0,                     // P evidence_verified_count
    0,                     // Q evidence_verified_rate
    0,                     // R unsupported_claim_count
    0,                     // S critical_failure_count
    0,                     // T regression_count
    0,                     // U avg_latency_ms
    0                      // V total_tool_calls
  ]);

  return {
    ok: true,
    created: true,
    run_id: runId,
    plugin: data.plugin,
    version: data.version,
    suite: data.suite,
    expected_test_count: expected,
    status: "RUNNING",
    started_at: now.toISOString()
  };
}

function saveRuntimeTestResultData(data) {
  ["run_id","test_id","plugin","version","status"].forEach(k => requireValue(data[k], k));

  const run = findRun(data.run_id);
  if (!run) throw new Error("run_id not found");
  if (String(run.status).toUpperCase() === "COMPLETED") {
    throw new Error("Evaluation run is already completed");
  }

  const status = normalizeStatus(data.status);
  if (!["PASS","FAIL","PARTIAL","NOT_EXECUTED"].includes(status)) {
    throw new Error("status must be PASS, FAIL, PARTIAL, or NOT_EXECUTED");
  }

  const now = new Date();
  const resultId = makeId("RUNTIME");

  getSheetOrThrow(CONFIG.SHEETS.RUNTIME_RESULTS).appendRow([
    resultId,                                      // A result_id
    data.run_id,                                   // B run_id
    data.test_id,                                  // C test_id
    data.plugin,                                   // D plugin
    data.version,                                  // E version
    data.prompt || "",                             // F prompt
    data.expected_route || "",                     // G expected_route
    data.expected_outcome || "",                   // H expected_outcome
    data.actual_route || "",                       // I actual_route
    data.actual_outcome || "",                     // J actual_outcome
    status,                                        // K status
    data.failure_reason || "",                     // L failure_reason
    data.root_cause || "",                         // M root_cause
    data.evidence_level || "",                     // N evidence_level
    JSON.stringify(data.source_refs || []),        // O source_refs_json
    bool(data.unsupported_claim),                  // P unsupported_claim
    bool(data.fabricated_quote_page),              // Q fabricated_quote_page
    bool(data.false_full_text_verification),       // R false_full_text_verification
    bool(data.invented_graph_edge),                // S invented_graph_edge
    bool(data.unsupported_author_agreement),       // T unsupported_author_agreement
    bool(data.critical_failure),                   // U critical_failure
    bool(data.regression),                         // V regression
    numberOrZero(data.latency_ms),                 // W latency_ms
    numberOrZero(data.tool_calls),                 // X tool_calls
    numberOrZero(data.repeatability_run),           // Y repeatability_run
    data.raw_trace_ref || "",                      // Z raw_trace_ref
    now                                            // AA executed_at
  ]);

  return {
    ok: true,
    saved: true,
    result_id: resultId,
    run_id: data.run_id,
    test_id: data.test_id,
    status,
    executed_at: now.toISOString()
  };
}

function completeEvaluationRunData(runId) {
  requireValue(runId, "run_id");

  const runLoc = findRunLocation(runId);
  if (!runLoc) throw new Error("run_id not found");

  const metrics = computeRunMetrics(runId);
  const now = new Date();
  const sheet = runLoc.sheet;
  const row = runLoc.row;

  sheet.getRange(row, 6).setValue("COMPLETED");
  sheet.getRange(row, 9).setValue(now);
  sheet.getRange(row, 10).setValue(metrics.executed_count);
  sheet.getRange(row, 11).setValue(metrics.pass_count);
  sheet.getRange(row, 12).setValue(metrics.fail_count);
  sheet.getRange(row, 13).setValue(metrics.partial_count);
  sheet.getRange(row, 14).setValue(metrics.not_executed_count);
  sheet.getRange(row, 15).setValue(metrics.pass_rate);
  sheet.getRange(row, 16).setValue(metrics.evidence_verified_count);
  sheet.getRange(row, 17).setValue(metrics.evidence_verified_rate);
  sheet.getRange(row, 18).setValue(metrics.unsupported_claim_count);
  sheet.getRange(row, 19).setValue(metrics.critical_failure_count);
  sheet.getRange(row, 20).setValue(metrics.regression_count);
  sheet.getRange(row, 21).setValue(metrics.avg_latency_ms);
  sheet.getRange(row, 22).setValue(metrics.total_tool_calls);

  return {
    ok: true,
    completed: true,
    run_id: runId,
    completed_at: now.toISOString(),
    metrics
  };
}

/* ---------------- Run queries ---------------- */

function getRunSummaryData(runId) {
  requireValue(runId, "run_id");
  const run = findRun(runId);
  if (!run) return { ok: false, error: "run_id not found" };

  return {
    ok: true,
    run,
    live_metrics: computeRunMetrics(runId)
  };
}

function getFailuresData(p) {
  let results = getRuntimeResultsRaw({
    run_id: p.run_id,
    plugin_name: p.plugin_name,
    version: p.version
  });

  results = results.filter(r =>
    r.status === "FAIL" ||
    r.status === "PARTIAL" ||
    r.status === "NOT_EXECUTED" ||
    r.critical_failure
  );

  if (String(p.critical_only || "").toLowerCase() === "true") {
    results = results.filter(r => r.critical_failure);
  }

  return { ok: true, count: results.length, results };
}

function getRegressionsData(p) {
  const results = getRuntimeResultsRaw({
    run_id: p.run_id,
    plugin_name: p.plugin_name,
    version: p.version
  }).filter(r => r.regression);

  return { ok: true, count: results.length, results };
}

function buildEvidencePackData(runId) {
  requireValue(runId, "run_id");
  const run = findRun(runId);
  if (!run) return { ok: false, error: "run_id not found" };

  const results = getRuntimeResultsRaw({ run_id: runId });
  const failures = results.filter(r =>
    r.status !== "PASS" || r.critical_failure || r.unsupported_claim || r.regression
  );
  const regressions = results.filter(r => r.regression);
  const critical = results.filter(r => r.critical_failure);

  return {
    ok: true,
    evidence_pack_version: "2.0",
    generated_at: new Date().toISOString(),
    run,
    metrics: computeRunMetrics(runId),
    failures,
    regressions,
    critical_failures: critical,
    results
  };
}

function releaseGateV2Data(runId) {
  requireValue(runId, "run_id");

  const run = findRun(runId);
  if (!run) return { ok: false, error: "run_id not found" };

  const m = computeRunMetrics(runId);
  const t = CONFIG.RELEASE_GATE_V2;
  const reasons = [];

  if (String(run.status).toUpperCase() !== "COMPLETED") {
    reasons.push("Evaluation run is not completed");
  }

  if (run.expected_test_count > 0 &&
      (m.executed_count + m.not_executed_count) < run.expected_test_count) {
    reasons.push("Evaluation suite is incomplete");
  }

  if (m.not_executed_count > t.MAX_NOT_EXECUTED) {
    reasons.push("NOT_EXECUTED tests exceed threshold");
  }

  if (m.pass_rate < t.MIN_PASS_RATE) {
    reasons.push("Pass rate below threshold");
  }

  if (m.evidence_verified_rate < t.MIN_EVIDENCE_VERIFIED_RATE) {
    reasons.push("Evidence-verified rate below threshold");
  }

  if (m.critical_failure_count > t.MAX_CRITICAL_FAILURES) {
    reasons.push("Critical failures present");
  }

  if (m.unsupported_claim_count > t.MAX_UNSUPPORTED_CLAIMS) {
    reasons.push("Unsupported claims present");
  }

  if (m.regression_count > t.MAX_REGRESSIONS) {
    reasons.push("Regressions present");
  }

  let decision = "PASS";
  if (reasons.length > 0) decision = "HOLD";
  if (m.critical_failure_count > 0 || m.unsupported_claim_count > 0) decision = "FAIL";

  return {
    ok: true,
    run_id: runId,
    plugin: run.plugin,
    version: run.version,
    suite: run.suite,
    decision,
    metrics: m,
    thresholds: t,
    reasons
  };
}

/* ---------------- Metrics ---------------- */

function computeRunMetrics(runId) {
  const results = getRuntimeResultsRaw({ run_id: runId });

  let pass = 0, fail = 0, partial = 0, notExecuted = 0;
  let evidenceVerified = 0, unsupported = 0, critical = 0, regressions = 0;
  let latencyTotal = 0, latencyCount = 0, totalToolCalls = 0;

  results.forEach(r => {
    if (r.status === "PASS") pass++;
    else if (r.status === "FAIL") fail++;
    else if (r.status === "PARTIAL") partial++;
    else if (r.status === "NOT_EXECUTED") notExecuted++;

    if (isEvidenceVerified(r.evidence_level)) evidenceVerified++;
    if (r.unsupported_claim) unsupported++;
    if (r.critical_failure) critical++;
    if (r.regression) regressions++;

    if (r.latency_ms > 0) {
      latencyTotal += r.latency_ms;
      latencyCount++;
    }
    totalToolCalls += r.tool_calls || 0;
  });

  const executed = pass + fail + partial;
  const passRate = executed ? Number((pass / executed * 100).toFixed(2)) : 0;
  const evidenceRate = executed
    ? Number((evidenceVerified / executed * 100).toFixed(2))
    : 0;

  return {
    result_count: results.length,
    executed_count: executed,
    pass_count: pass,
    fail_count: fail,
    partial_count: partial,
    not_executed_count: notExecuted,
    pass_rate: passRate,
    evidence_verified_count: evidenceVerified,
    evidence_verified_rate: evidenceRate,
    unsupported_claim_count: unsupported,
    critical_failure_count: critical,
    regression_count: regressions,
    avg_latency_ms: latencyCount ? Math.round(latencyTotal / latencyCount) : 0,
    total_tool_calls: totalToolCalls
  };
}

/* ---------------- Raw readers ---------------- */

function getRuntimeResultsRaw(filter) {
  let rows = dataRows(CONFIG.SHEETS.RUNTIME_RESULTS).filter(r => r[0]);

  if (filter.run_id) rows = rows.filter(r => String(r[1]) === String(filter.run_id));
  if (filter.plugin_name) {
    const target = normalizeText(filter.plugin_name);
    rows = rows.filter(r => normalizeText(r[3]) === target);
  }
  if (hasValue(filter.version)) {
    rows = rows.filter(r => String(r[4]).trim() === String(filter.version).trim());
  }

  return rows.map(r => ({
    result_id: r[0],
    run_id: r[1],
    test_id: r[2],
    plugin: r[3],
    version: r[4],
    prompt: r[5],
    expected_route: r[6],
    expected_outcome: r[7],
    actual_route: r[8],
    actual_outcome: r[9],
    status: normalizeStatus(r[10]),
    failure_reason: r[11],
    root_cause: r[12],
    evidence_level: r[13],
    source_refs: parseJsonArray(r[14]),
    unsupported_claim: bool(r[15]),
    fabricated_quote_page: bool(r[16]),
    false_full_text_verification: bool(r[17]),
    invented_graph_edge: bool(r[18]),
    unsupported_author_agreement: bool(r[19]),
    critical_failure: bool(r[20]),
    regression: bool(r[21]),
    latency_ms: numberOrZero(r[22]),
    tool_calls: numberOrZero(r[23]),
    repeatability_run: numberOrZero(r[24]),
    raw_trace_ref: r[25],
    executed_at: serializeDate(r[26])
  }));
}

function findRun(runId) {
  const loc = findRunLocation(runId);
  if (!loc) return null;

  const r = loc.values;
  return {
    run_id: r[0],
    plugin: r[1],
    version: r[2],
    suite: r[3],
    expected_test_count: numberOrZero(r[4]),
    status: r[5],
    notes: r[6],
    started_at: serializeDate(r[7]),
    completed_at: serializeDate(r[8]),
    executed_count: numberOrZero(r[9]),
    pass_count: numberOrZero(r[10]),
    fail_count: numberOrZero(r[11]),
    partial_count: numberOrZero(r[12]),
    not_executed_count: numberOrZero(r[13]),
    pass_rate: numberOrZero(r[14]),
    evidence_verified_count: numberOrZero(r[15]),
    evidence_verified_rate: numberOrZero(r[16]),
    unsupported_claim_count: numberOrZero(r[17]),
    critical_failure_count: numberOrZero(r[18]),
    regression_count: numberOrZero(r[19]),
    avg_latency_ms: numberOrZero(r[20]),
    total_tool_calls: numberOrZero(r[21])
  };
}

function findRunLocation(runId) {
  const sheet = getSheetOrThrow(CONFIG.SHEETS.EVALUATION_RUNS);
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(runId)) {
      return { sheet, row: i + 1, values: values[i] };
    }
  }
  return null;
}

/* ---------------- Sheet helpers ---------------- */

function dataRows(sheetName) {
  const values = getSheetOrThrow(sheetName).getDataRange().getValues();
  return values.length <= 1 ? [] : values.slice(1);
}

function getSheetOrThrow(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("No active spreadsheet found");
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error("Sheet '" + sheetName + "' not found");
  return sheet;
}

function sheetExists(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return !!(ss && ss.getSheetByName(sheetName));
}

/* ---------------- Generic helpers ---------------- */

function requireValue(value, name) {
  if (!hasValue(value)) throw new Error(name + " is required");
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function normalizeText(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeStatus(v) {
  return String(v || "").trim().toUpperCase();
}

function bool(v) {
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true";
}

function numberOrZero(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function serializeDate(v) {
  return v instanceof Date ? v.toISOString() : (v || "");
}

function makeId(prefix) {
  const now = new Date();
  const tz = Session.getScriptTimeZone() || "Asia/Bangkok";
  return prefix + "-" +
    Utilities.formatDate(now, tz, "yyyyMMdd-HHmmss") + "-" +
    Utilities.getUuid().substring(0, 8);
}

function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function isEvidenceVerified(level) {
  const x = String(level || "").trim().toUpperCase();
  return ["VERIFIED","PRIMARY","HIGH","FULL"].includes(x);
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(err, source) {
  return jsonResponse({
    ok: false,
    error: err && err.message ? err.message : String(err),
    source: source || null,
    stack: err && err.stack ? String(err.stack) : null
  });
}
