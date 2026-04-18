// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "./web-search";

// Providers that run on the host and need the local-inference policy preset.
export const LOCAL_INFERENCE_PROVIDERS = ["ollama-local", "vllm-local"] as const;

export interface SuggestedPolicyPresetDeps {
  enabledChannels?: string[] | null;
  webSearchConfig?: WebSearchConfig | null;
  provider?: string | null;
  getCredential: (envKey: string) => string | null;
  env?: NodeJS.ProcessEnv;
  isInteractiveTty?: boolean;
  isNonInteractive?: boolean;
  note?: (message: string) => void;
}

export function getSuggestedPolicyPresets(
  deps: SuggestedPolicyPresetDeps,
): string[] {
  const env = deps.env ?? process.env;
  const note = deps.note ?? (() => {});
  const suggestions = ["pypi", "npm"];

  if (deps.provider && LOCAL_INFERENCE_PROVIDERS.includes(deps.provider as never)) {
    suggestions.push("local-inference");
  }
  const usesExplicitMessagingSelection = Array.isArray(deps.enabledChannels);

  const maybeSuggestMessagingPreset = (channel: string, envKey: string) => {
    if (usesExplicitMessagingSelection) {
      if (deps.enabledChannels?.includes(channel)) suggestions.push(channel);
      return;
    }
    if (deps.getCredential(envKey) || env[envKey]) {
      suggestions.push(channel);
      if (deps.isInteractiveTty && !deps.isNonInteractive && env.CI !== "true") {
        note(`  Auto-detected: ${envKey} -> suggesting ${channel} preset`);
      }
    }
  };

  maybeSuggestMessagingPreset("telegram", "TELEGRAM_BOT_TOKEN");
  maybeSuggestMessagingPreset("slack", "SLACK_BOT_TOKEN");
  maybeSuggestMessagingPreset("discord", "DISCORD_BOT_TOKEN");

  if (deps.webSearchConfig) suggestions.push("brave");

  return suggestions;
}
