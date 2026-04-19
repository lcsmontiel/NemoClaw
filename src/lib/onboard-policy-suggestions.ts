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

export interface TierPolicySuggestionDeps {
  enabledChannels?: string[] | null;
  webSearchConfig?: WebSearchConfig | null;
  provider?: string | null;
  knownPresetNames?: string[] | null;
  resolveTierPresets: (tierName: string) => Array<{ name: string }>;
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

export function computeSetupPresetSuggestions(
  tierName: string,
  deps: TierPolicySuggestionDeps,
): string[] {
  const { enabledChannels = null, webSearchConfig = null, provider = null } = deps;
  const known = Array.isArray(deps.knownPresetNames) ? new Set(deps.knownPresetNames) : null;
  const suggestions = deps.resolveTierPresets(tierName).map((preset) => preset.name);
  const add = (name: string) => {
    if (suggestions.includes(name)) return;
    if (known && !known.has(name)) return;
    suggestions.push(name);
  };
  if (webSearchConfig) add("brave");
  if (provider && LOCAL_INFERENCE_PROVIDERS.includes(provider as never)) add("local-inference");
  if (Array.isArray(enabledChannels)) {
    for (const channel of enabledChannels) add(channel);
  }
  return suggestions;
}
