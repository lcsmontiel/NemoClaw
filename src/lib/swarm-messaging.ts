// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-instance messaging provider management for swarm agents.
 *
 * Each agent instance gets its own set of messaging providers so tokens
 * are isolated between instances. Provider names are scoped by instance ID
 * (e.g., "my-sandbox-hermes-0-telegram-bridge").
 */

import type { MessagingTokens } from "./swarm-config";

const { run, shellQuote } = require("./runner");

export interface MessagingProviderDef {
  name: string;
  envKey: string;
  token: string;
  channel: string;
}

const CHANNEL_ENV_KEYS: Record<string, string> = {
  telegram: "TELEGRAM_BOT_TOKEN",
  discord: "DISCORD_BOT_TOKEN",
  slack: "SLACK_BOT_TOKEN",
};

function getOpenshellCommand(): string {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN;
  if (!binary) return "openshell";
  return shellQuote(binary);
}

/**
 * Build the list of provider definitions for an instance's messaging tokens.
 */
export function buildProviderDefs(
  sandboxName: string,
  instanceId: string,
  tokens: MessagingTokens,
): MessagingProviderDef[] {
  const defs: MessagingProviderDef[] = [];
  for (const [channel, envKey] of Object.entries(CHANNEL_ENV_KEYS)) {
    const token = tokens[channel as keyof MessagingTokens];
    if (!token) continue;
    defs.push({
      name: `${sandboxName}-${instanceId}-${channel}-bridge`,
      envKey,
      token,
      channel,
    });
  }
  return defs;
}

/**
 * Create or update messaging providers for an agent instance.
 * Returns the list of created provider names and active channel names.
 */
export function createInstanceMessagingProviders(
  sandboxName: string,
  instanceId: string,
  tokens: MessagingTokens,
): { providers: string[]; channels: string[] } {
  const defs = buildProviderDefs(sandboxName, instanceId, tokens);
  const providers: string[] = [];
  const channels: string[] = [];

  for (const def of defs) {
    const openshell = getOpenshellCommand();
    // Try create, fall back to update (same pattern as onboard)
    const createCmd = `${openshell} provider create --name ${shellQuote(def.name)} --type generic --credential ${shellQuote(def.envKey)}`;
    const createResult = run(createCmd, {
      ignoreError: true,
      suppressOutput: true,
      env: { [def.envKey]: def.token },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (createResult.status !== 0) {
      const updateCmd = `${openshell} provider update ${shellQuote(def.name)} --credential ${shellQuote(def.envKey)}`;
      const updateResult = run(updateCmd, {
        ignoreError: true,
        suppressOutput: true,
        env: { [def.envKey]: def.token },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (updateResult.status !== 0) {
        console.error(`  Warning: failed to create messaging provider '${def.name}'`);
        continue;
      }
    }

    providers.push(def.name);
    channels.push(def.channel);
  }

  return { providers, channels };
}

/**
 * Parse messaging token flags from CLI args.
 */
export function parseMessagingFlags(args: string[]): MessagingTokens {
  const tokens: MessagingTokens = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--telegram-token" && args[i + 1]) {
      tokens.telegram = args[++i];
    } else if (args[i] === "--discord-token" && args[i + 1]) {
      tokens.discord = args[++i];
    } else if (args[i] === "--slack-token" && args[i + 1]) {
      tokens.slack = args[++i];
    }
  }
  return tokens;
}
