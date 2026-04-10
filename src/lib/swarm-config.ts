// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-agent-type config generation for swarm instances.
 *
 * Each agent type has a different config format (OpenClaw: JSON, Hermes:
 * YAML + .env). This module generates the config files for a new instance
 * and builds the shell script to deploy them inside the sandbox.
 */

import type { AgentDefinition } from "./agent-defs";

export interface InstanceConfig {
  /** Shell script that creates dirs, writes config, and sets permissions. */
  setupScript: string;
}

export interface MessagingTokens {
  telegram?: string;
  discord?: string;
  slack?: string;
}

/**
 * Build the shell script that creates config/data dirs, writes agent config,
 * and sets up symlinks + permissions inside the sandbox.
 */
export function buildInstanceSetupScript(opts: {
  instanceId: string;
  agentDef: AgentDefinition;
  configDir: string;
  dataDir: string;
  port: number;
  inferenceEndpoint: string;
  model: string;
  messagingTokens?: MessagingTokens;
}): InstanceConfig {
  const { instanceId, agentDef, configDir, dataDir, port, inferenceEndpoint, model } = opts;
  const lines: string[] = [];

  lines.push(`# Setup for ${instanceId} (${agentDef.name})`);
  lines.push(`set -euo pipefail`);
  lines.push("");

  // Create directories
  lines.push(`mkdir -p ${configDir}`);
  lines.push(`mkdir -p ${dataDir}`);
  lines.push("");

  // Create state dir symlinks (from manifest)
  for (const stateDir of agentDef.stateDirs) {
    lines.push(`mkdir -p ${dataDir}/${stateDir}`);
    // Only create symlink if it doesn't already exist
    lines.push(`[ -L ${configDir}/${stateDir} ] || ln -sf ${dataDir}/${stateDir} ${configDir}/${stateDir}`);
  }
  lines.push("");

  // Generate config based on agent type
  if (agentDef.name === "openclaw") {
    lines.push(...buildOpenClawConfig(configDir, port, inferenceEndpoint, model));
  } else if (agentDef.name === "hermes") {
    lines.push(...buildHermesConfig(configDir, port, inferenceEndpoint, model));
  } else {
    // Generic: write a minimal JSON config
    lines.push(...buildGenericConfig(configDir, port, inferenceEndpoint, model, agentDef.name));
  }

  lines.push("");

  // Set ownership (sandbox user for data, root for config)
  lines.push(`chown -R sandbox:sandbox ${dataDir}`);
  lines.push(`chmod 755 ${configDir}`);

  return { setupScript: lines.join("\n") };
}

function buildOpenClawConfig(configDir: string, port: number, endpoint: string, model: string): string[] {
  const config = {
    gateway: { port },
    providers: [
      {
        name: "nemoclaw-inference",
        type: "openai",
        baseUrl: endpoint,
        models: [model],
      },
    ],
    defaultModel: model,
  };
  const json = JSON.stringify(config, null, 2);
  return [
    `cat > ${configDir}/openclaw.json <<'NEMOCLAW_CONFIG_EOF'`,
    json,
    "NEMOCLAW_CONFIG_EOF",
    `sha256sum ${configDir}/openclaw.json | awk '{print $1}' > ${configDir}/.config-hash`,
  ];
}

function buildHermesConfig(configDir: string, port: number, endpoint: string, model: string): string[] {
  // Hermes uses YAML config + .env file
  const configYaml = [
    "server:",
    `  port: ${port}`,
    `  host: "0.0.0.0"`,
    "",
    "model:",
    `  default: "${model}"`,
    `  base_url: "${endpoint}"`,
    `  provider: "custom"`,
  ].join("\n");

  const envFile = [
    `# Generated for swarm instance`,
    `API_SERVER_KEY=nemoclaw-swarm-${Date.now()}`,
  ].join("\n");

  return [
    `cat > ${configDir}/config.yaml <<'NEMOCLAW_CONFIG_EOF'`,
    configYaml,
    "NEMOCLAW_CONFIG_EOF",
    `cat > ${configDir}/.env <<'NEMOCLAW_ENV_EOF'`,
    envFile,
    "NEMOCLAW_ENV_EOF",
    `sha256sum ${configDir}/config.yaml ${configDir}/.env | sha256sum | awk '{print $1}' > ${configDir}/.config-hash`,
  ];
}

function buildGenericConfig(
  configDir: string,
  port: number,
  endpoint: string,
  model: string,
  agentName: string,
): string[] {
  const config = { agent: agentName, port, inferenceEndpoint: endpoint, model };
  const json = JSON.stringify(config, null, 2);
  return [
    `cat > ${configDir}/config.json <<'NEMOCLAW_CONFIG_EOF'`,
    json,
    "NEMOCLAW_CONFIG_EOF",
  ];
}
