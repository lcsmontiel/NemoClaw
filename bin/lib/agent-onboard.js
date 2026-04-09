// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific onboarding logic — called from onboard.js when a
// non-default agent (e.g. Hermes) is selected via --agent flag or
// NEMOCLAW_AGENT env var. The OpenClaw path never touches this module.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { ROOT, run, shellQuote } = require("./runner");
const { loadAgent, resolveAgentName } = require("./agent-defs");
const { getProviderSelectionConfig } = require("./inference-config");
const onboardSession = require("./onboard-session");

// ── Agent resolution ────────────────────────────────────────────

/**
 * Resolve the effective agent from CLI flags, env, or session.
 * Returns null for openclaw (default path), loaded agent object otherwise.
 * @param {{ agentFlag?: string|null, session?: object|null }} opts
 * @returns {object|null}
 */
function resolveAgent({ agentFlag = null, session = null } = {}) {
  const name = resolveAgentName({ agentFlag, session });
  if (name === "openclaw") return null;
  return loadAgent(name);
}

// ── Agent sandbox creation ──────────────────────────────────────

/**
 * Stage build context for an agent-specific sandbox image.
 * Builds the base image if the agent defines one and it's not cached locally.
 *
 * @param {object} agent — loaded agent definition from agent-defs.js
 * @returns {{ buildCtx: string, stagedDockerfile: string }}
 */
function createAgentSandbox(agent) {
  const agentDockerfile = agent.dockerfilePath;
  const baseDockerfile = agent.dockerfileBasePath;

  if (baseDockerfile) {
    const baseImageTag = `ghcr.io/nvidia/nemoclaw/${agent.name}-sandbox-base:latest`;
    const inspectResult = run(`docker image inspect ${shellQuote(baseImageTag)} >/dev/null 2>&1`, {
      ignoreError: true,
    });
    if (inspectResult.status !== 0) {
      console.log(`  Building ${agent.displayName} base image (first time only)...`);
      run(
        `docker build -f ${shellQuote(baseDockerfile)} -t ${shellQuote(baseImageTag)} ${shellQuote(ROOT)}`,
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      console.log(`  ✓ Base image built: ${baseImageTag}`);
    } else {
      console.log(`  Base image exists: ${baseImageTag}`);
    }
  }

  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
  fs.cpSync(ROOT, buildCtx, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return !["node_modules", ".git", ".venv", "__pycache__", ".claude"].includes(base);
    },
  });
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.copyFileSync(agentDockerfile, stagedDockerfile);
  console.log(`  Using ${agent.displayName} Dockerfile: ${agentDockerfile}`);

  return { buildCtx, stagedDockerfile };
}

/**
 * Get the agent-specific network policy path, or null to use the default.
 */
function getAgentPolicyPath(agent) {
  return agent.policyAdditionsPath || null;
}

// ── Agent setup inside sandbox ──────────────────────────────────

function sleep(seconds) {
  spawnSync("sleep", [String(seconds)]);
}

/**
 * Handle the full agent setup step (step 7) including resume detection.
 * For non-OpenClaw agents: writes config into the sandbox and verifies
 * the agent's health probe.
 *
 * @param {string} sandboxName
 * @param {string} model
 * @param {string} provider
 * @param {object} agent — loaded agent definition
 * @param {boolean} resume — whether we're in resume mode
 * @param {object} session — current onboard session
 * @param {object} ctx — onboard.js context functions
 */
async function handleAgentSetup(sandboxName, model, provider, agent, resume, session, ctx) {
  const {
    step,
    runCaptureOpenshell,
    openshellShellCommand,
    buildSandboxConfigSyncScript,
    writeSandboxConfigSyncFile,
    cleanupTempDir,
    startRecordedStep,
    skippedStepMessage,
  } = ctx;

  // Resume check: verify the agent's health probe, not just pod readiness.
  // A running sandbox doesn't guarantee the agent gateway has bound its port.
  if (resume && sandboxName) {
    const probe = agent.healthProbe;
    if (probe?.url) {
      const result = runCaptureOpenshell(
        ["sandbox", "exec", sandboxName, "curl", "-sf", "--max-time", "3", probe.url],
        { ignoreError: true },
      );
      if (result && result.includes("ok")) {
        skippedStepMessage("agent_setup", sandboxName);
        onboardSession.markStepComplete("agent_setup", { sandboxName, provider, model });
        return;
      }
    }
  }

  startRecordedStep("agent_setup", { sandboxName, provider, model });
  step(7, 8, `Setting up ${agent.displayName} inside sandbox`);

  // Write NemoClaw selection config into the sandbox.
  const selectionConfig = getProviderSelectionConfig(provider, model);
  if (selectionConfig) {
    const sandboxConfig = {
      ...selectionConfig,
      agent: agent.name,
      onboardedAt: new Date().toISOString(),
    };
    const script = buildSandboxConfigSyncScript(sandboxConfig);
    const scriptFile = writeSandboxConfigSyncFile(script);
    try {
      run(
        `${openshellShellCommand(["sandbox", "connect", sandboxName])} < ${shellQuote(scriptFile)}`,
        { stdio: ["ignore", "ignore", "inherit"] },
      );
    } finally {
      cleanupTempDir(scriptFile, "nemoclaw-sync");
    }
  }

  // Verify agent health via the configured health probe
  const probe = agent.healthProbe;
  if (probe?.url) {
    console.log(`  Waiting for ${agent.displayName} gateway...`);
    let healthy = false;
    for (let i = 0; i < 15; i++) {
      const result = runCaptureOpenshell(
        ["sandbox", "exec", sandboxName, "curl", "-sf", probe.url],
        { ignoreError: true },
      );
      if (result && result.includes("ok")) {
        healthy = true;
        break;
      }
      sleep(2);
    }
    if (healthy) {
      console.log(`  ✓ ${agent.displayName} gateway is healthy`);
    } else {
      console.log(
        `  ⚠ ${agent.displayName} gateway health check timed out (may still be starting)`,
      );
    }
  } else {
    console.log(`  ✓ ${agent.displayName} configured inside sandbox`);
  }

  onboardSession.markStepComplete("agent_setup", { sandboxName, provider, model });
}

// ── Agent dashboard ─────────────────────────────────────────────

/**
 * Get dashboard info for a non-OpenClaw agent.
 * @returns {{ port: number, displayName: string }}
 */
function getAgentDashboardInfo(agent) {
  return {
    port: agent.forwardPort,
    displayName: agent.displayName,
  };
}

/**
 * Print the dashboard UI section for a non-OpenClaw agent.
 */
function printDashboardUi(sandboxName, token, agent, deps) {
  const { note, buildControlUiUrls } = deps;
  const info = getAgentDashboardInfo(agent);
  if (token) {
    console.log(`  ${info.displayName} UI (tokenized URL; treat it like a password)`);
    console.log(`  Port ${info.port} must be forwarded before opening this URL.`);
    for (const url of buildControlUiUrls(token, info.port)) {
      console.log(`  ${url}`);
    }
  } else {
    note("  Could not read gateway token from the sandbox (download failed).");
    console.log(`  ${info.displayName} UI`);
    console.log(`  Port ${info.port} must be forwarded before opening this URL.`);
    for (const url of buildControlUiUrls(null, info.port)) {
      console.log(`  ${url}`);
    }
  }
}

module.exports = {
  resolveAgent,
  createAgentSandbox,
  getAgentPolicyPath,
  handleAgentSetup,
  getAgentDashboardInfo,
  printDashboardUi,
};
