// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Swarm manifest management — read/write the manifest inside the sandbox.
 *
 * The manifest lives at /sandbox/.nemoclaw/swarm/manifest.json and tracks
 * all agent instances, their ports, health URLs, and the bus configuration.
 */

import type { AgentInstance } from "./registry";

export interface SwarmManifestAgent {
  instanceId: string;
  agentType: string;
  port: number;
  configDir: string;
  healthUrl: string;
  primary: boolean;
  messagingChannels?: string[];
  decodeProxyPort?: number;
}

export interface SwarmManifest {
  version: number;
  agents: SwarmManifestAgent[];
  bus: {
    port: number;
    logFile: string;
  };
}

export const SWARM_DIR = "/sandbox/.nemoclaw/swarm";
export const SWARM_MANIFEST_PATH = `${SWARM_DIR}/manifest.json`;
export const SWARM_BUS_LOG = `${SWARM_DIR}/messages.jsonl`;

/** Build a manifest agent entry from a registry AgentInstance and health URL. */
export function toManifestAgent(instance: AgentInstance, healthUrl: string): SwarmManifestAgent {
  const entry: SwarmManifestAgent = {
    instanceId: instance.instanceId,
    agentType: instance.agentType,
    port: instance.port,
    configDir: instance.configDir,
    healthUrl,
    primary: instance.primary,
  };
  if (instance.messagingChannels && instance.messagingChannels.length > 0) {
    entry.messagingChannels = instance.messagingChannels;
  }
  return entry;
}

/** Build a fresh manifest with a single agent (for bootstrapping). */
export function createManifest(agent: SwarmManifestAgent, busPort: number): SwarmManifest {
  return {
    version: 1,
    agents: [agent],
    bus: { port: busPort, logFile: SWARM_BUS_LOG },
  };
}

/** Build the shell commands to create the swarm directory and write the manifest. */
export function buildWriteManifestScript(manifest: SwarmManifest): string {
  const json = JSON.stringify(manifest, null, 2);
  // Use heredoc to avoid quoting issues with JSON content
  return [
    `mkdir -p ${SWARM_DIR}`,
    `cat > ${SWARM_MANIFEST_PATH} <<'NEMOCLAW_MANIFEST_EOF'`,
    json,
    "NEMOCLAW_MANIFEST_EOF",
  ].join("\n");
}

/** Build the shell command to read the manifest from inside the sandbox. */
export function buildReadManifestCommand(): string {
  return `cat ${SWARM_MANIFEST_PATH} 2>/dev/null`;
}

/** Parse a manifest JSON string. Returns null on failure. */
export function parseManifest(raw: string): SwarmManifest | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.agents)) {
      return parsed as SwarmManifest;
    }
    return null;
  } catch {
    return null;
  }
}
