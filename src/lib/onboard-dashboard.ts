// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Dashboard URL management, port forwarding, and summary display.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { runCapture: defaultRunCapture } = require("./runner");
const { isWsl } = require("./platform");
const { DASHBOARD_PORT } = require("./ports");
const dashboard = require("./dashboard");
const nim = require("./nim");
const agentOnboard = require("./agent-onboard");
const { getProviderLabel } = require("./onboard-providers");

const CONTROL_UI_PORT = DASHBOARD_PORT;
const { resolveDashboardForwardTarget, buildControlUiUrls } = dashboard;

// ── Port forwarding ──────────────────────────────────────────────

function ensureDashboardForward(sandboxName, chatUiUrl, _runOpenshell) {
  chatUiUrl = chatUiUrl || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const portToStop = getDashboardForwardPort(chatUiUrl);
  const forwardTarget = getDashboardForwardTarget(chatUiUrl);
  _runOpenshell(["forward", "stop", portToStop], { ignoreError: true });
  const fwdResult = _runOpenshell(["forward", "start", "--background", forwardTarget, sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (fwdResult && fwdResult.status !== 0) {
    console.warn(`! Port ${portToStop} forward did not start — port may be in use by another process.`);
    console.warn(`  Check: docker ps --format 'table {{.Names}}\\t{{.Ports}}' | grep ${portToStop}`);
    console.warn(`  Free the port, then reconnect: nemoclaw ${sandboxName} connect`);
  }
}

// ── Token retrieval ──────────────────────────────────────────────

function findOpenclawJsonPath(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = findOpenclawJsonPath(p);
      if (found) return found;
    } else if (e.name === "openclaw.json") {
      return p;
    }
  }
  return null;
}

function fetchGatewayAuthTokenFromSandbox(sandboxName, _runOpenshell) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-token-"));
  try {
    const destDir = `${tmpDir}${path.sep}`;
    const result = _runOpenshell(
      ["sandbox", "download", sandboxName, "/sandbox/.openclaw/openclaw.json", destDir],
      { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    if (result.status !== 0) return null;
    const jsonPath = findOpenclawJsonPath(tmpDir);
    if (!jsonPath) return null;
    const cfg = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const token = cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

// ── URL helpers ──────────────────────────────────────────────────

function getDashboardForwardPort(
  chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
) {
  const forwardTarget = resolveDashboardForwardTarget(chatUiUrl);
  return forwardTarget.includes(":")
    ? (forwardTarget.split(":").pop() ?? String(CONTROL_UI_PORT))
    : forwardTarget;
}

function getDashboardForwardTarget(
  chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
  options = {},
) {
  const port = getDashboardForwardPort(chatUiUrl);
  return isWsl(options) ? `0.0.0.0:${port}` : resolveDashboardForwardTarget(chatUiUrl);
}

function getDashboardForwardStartCommand(sandboxName, options = {}, _openshellShellCommand = null) {
  const chatUiUrl =
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const forwardTarget = getDashboardForwardTarget(chatUiUrl, options);
  return `${_openshellShellCommand(
    ["forward", "start", "--background", forwardTarget, sandboxName],
    options,
  )}`;
}

function buildAuthenticatedDashboardUrl(baseUrl, token = null) {
  if (!token) return baseUrl;
  return `${baseUrl}#token=${encodeURIComponent(token)}`;
}

function getWslHostAddress(options = {}) {
  if (options.wslHostAddress) {
    return options.wslHostAddress;
  }
  if (!isWsl(options)) {
    return null;
  }
  const runCaptureFn = options.runCapture || defaultRunCapture;
  const output = runCaptureFn("hostname -I 2>/dev/null", { ignoreError: true });
  const candidates = String(output || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return candidates[0] || null;
}

function getDashboardAccessInfo(sandboxName, options = {}, _runOpenshell = null) {
  const token = Object.prototype.hasOwnProperty.call(options, "token")
    ? options.token
    : fetchGatewayAuthTokenFromSandbox(sandboxName, _runOpenshell);
  const chatUiUrl =
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const dashboardPort = Number(getDashboardForwardPort(chatUiUrl));
  const dashboardAccess = buildControlUiUrls(token, dashboardPort).map((url, index) => ({
    label: index === 0 ? "Dashboard" : `Alt ${index}`,
    url: buildAuthenticatedDashboardUrl(url, null),
  }));

  const wslHostAddress = getWslHostAddress(options);
  if (wslHostAddress) {
    const wslUrl = buildAuthenticatedDashboardUrl(
      `http://${wslHostAddress}:${dashboardPort}/`,
      token,
    );
    if (!dashboardAccess.some((access) => access.url === wslUrl)) {
      dashboardAccess.push({ label: "VS Code/WSL", url: wslUrl });
    }
  }

  return dashboardAccess;
}

function getDashboardGuidanceLines(dashboardAccess = [], options = {}) {
  const dashboardPort = getDashboardForwardPort(
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
  );
  const guidance = [`Port ${dashboardPort} must be forwarded before opening these URLs.`];
  if (isWsl(options)) {
    guidance.push(
      "WSL detected: if localhost fails in Windows, use the WSL host IP shown by `hostname -I`.",
    );
  }
  if (dashboardAccess.length === 0) {
    guidance.push("No dashboard URLs were generated.");
  }
  return guidance;
}

// ── Summary printer ──────────────────────────────────────────────

function printDashboard(sandboxName, model, provider, nimContainer, agent, deps) {
  const { note, runOpenshell, runCapture = defaultRunCapture } = deps;
  const nimStat = nimContainer ? nim.nimStatusByName(nimContainer) : nim.nimStatus(sandboxName);
  const nimLabel = nimStat.running ? "running" : "not running";

  const providerLabel = getProviderLabel(provider);

  const token = fetchGatewayAuthTokenFromSandbox(sandboxName, runOpenshell);
  const dashboardAccess = getDashboardAccessInfo(sandboxName, { token, runCapture }, runOpenshell);
  const guidanceLines = getDashboardGuidanceLines(dashboardAccess);

  console.log("");
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Sandbox      ${sandboxName} (Landlock + seccomp + netns)`);
  console.log(`  Model        ${model} (${providerLabel})`);
  console.log(`  NIM          ${nimLabel}`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Run:         nemoclaw ${sandboxName} connect`);
  console.log(`  Status:      nemoclaw ${sandboxName} status`);
  console.log(`  Logs:        nemoclaw ${sandboxName} logs --follow`);
  console.log("");
  if (agent) {
    agentOnboard.printDashboardUi(sandboxName, token, agent, {
      note,
      buildControlUiUrls: (tokenValue, port) => {
        const urls = buildControlUiUrls(tokenValue, port);
        const wslHostAddress = getWslHostAddress({ runCapture });
        if (wslHostAddress) {
          const wslUrl = buildAuthenticatedDashboardUrl(
            `http://${wslHostAddress}:${port}/`,
            tokenValue,
          );
          if (!urls.includes(wslUrl)) {
            urls.push(wslUrl);
          }
        }
        return urls;
      },
    });
  } else if (token) {
    console.log("  OpenClaw UI (tokenized URL; treat it like a password)");
    for (const line of guidanceLines) {
      console.log(`  ${line}`);
    }
    for (const entry of dashboardAccess) {
      console.log(`  ${entry.label}: ${entry.url}`);
    }
  } else {
    note("  Could not read gateway token from the sandbox (download failed).");
    console.log("  OpenClaw UI");
    for (const line of guidanceLines) {
      console.log(`  ${line}`);
    }
    for (const entry of dashboardAccess) {
      console.log(`  ${entry.label}: ${entry.url}`);
    }
    console.log(
      `  Token:       nemoclaw ${sandboxName} connect  →  jq -r '.gateway.auth.token' /sandbox/.openclaw/openclaw.json`,
    );
    console.log(
      `               append  #token=<token>  to the URL, or see /tmp/gateway.log inside the sandbox.`,
    );
  }
  console.log(`  ${"─".repeat(50)}`);
  console.log("");
}

module.exports = {
  CONTROL_UI_PORT,
  resolveDashboardForwardTarget,
  buildControlUiUrls,
  ensureDashboardForward,
  findOpenclawJsonPath,
  fetchGatewayAuthTokenFromSandbox,
  getDashboardForwardPort,
  getDashboardForwardTarget,
  getDashboardForwardStartCommand,
  buildAuthenticatedDashboardUrl,
  getWslHostAddress,
  getDashboardAccessInfo,
  getDashboardGuidanceLines,
  printDashboard,
};
