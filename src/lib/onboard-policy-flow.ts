// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "./web-search";

export interface PolicyFlowState {
  sandboxName: string;
  provider: string;
  model: string;
  webSearchConfig: WebSearchConfig | null;
  enabledChannels: string[];
  recordedPolicyPresets: string[] | null;
}

export interface PolicyFlowDeps {
  resume: boolean;
  dangerouslySkipPermissions: boolean;
  hasCompletedPolicies: boolean;
  waitForSandboxReady: (sandboxName: string) => boolean;
  applyPermissivePolicy: (sandboxName: string) => void;
  arePolicyPresetsApplied: (sandboxName: string, selectedPresets: string[]) => boolean;
  setupPoliciesWithSelection: (
    sandboxName: string,
    options: {
      selectedPresets: string[] | null;
      enabledChannels: string[];
      webSearchConfig: WebSearchConfig | null;
      provider: string;
      onSelection: (policyPresets: string[]) => void;
    },
  ) => Promise<string[]>;
  onShowHeader: () => void;
  onSkip: (stepName: "policies", detail: string) => void;
  onStartStep: (
    stepName: "policies",
    updates?: { sandboxName?: string; provider?: string; model?: string; policyPresets?: string[] },
  ) => void;
  onCompleteStep: (
    stepName: "policies",
    updates?: { sandboxName?: string; provider?: string; model?: string; policyPresets?: string[] },
  ) => void;
  onSelectionPersist: (policyPresets: string[]) => void;
}

export type PolicyFlowResult =
  | { kind: "complete"; policyPresets: string[] }
  | { kind: "sandbox_not_ready"; message: string };

export async function runPolicySetupFlow(
  state: PolicyFlowState,
  deps: PolicyFlowDeps,
): Promise<PolicyFlowResult> {
  if (deps.dangerouslySkipPermissions) {
    deps.onShowHeader();
    if (!deps.waitForSandboxReady(state.sandboxName)) {
      return {
        kind: "sandbox_not_ready",
        message: `  ✗ Sandbox '${state.sandboxName}' not ready after creation. Giving up.`,
      };
    }
    deps.applyPermissivePolicy(state.sandboxName);
    deps.onCompleteStep("policies", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
      policyPresets: [],
    });
    return { kind: "complete", policyPresets: [] };
  }

  const resumePolicies =
    deps.hasCompletedPolicies &&
    deps.arePolicyPresetsApplied(state.sandboxName, state.recordedPolicyPresets || []);
  if (resumePolicies) {
    deps.onSkip("policies", (state.recordedPolicyPresets || []).join(", "));
    deps.onCompleteStep("policies", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
      policyPresets: state.recordedPolicyPresets || [],
    });
    return { kind: "complete", policyPresets: state.recordedPolicyPresets || [] };
  }

  deps.onStartStep("policies", {
    sandboxName: state.sandboxName,
    provider: state.provider,
    model: state.model,
    policyPresets: state.recordedPolicyPresets || [],
  });
  const appliedPolicyPresets = await deps.setupPoliciesWithSelection(state.sandboxName, {
    selectedPresets:
      Array.isArray(state.recordedPolicyPresets) && state.recordedPolicyPresets.length > 0
        ? state.recordedPolicyPresets
        : null,
    enabledChannels: state.enabledChannels,
    webSearchConfig: state.webSearchConfig,
    provider: state.provider,
    onSelection: deps.onSelectionPersist,
  });
  deps.onCompleteStep("policies", {
    sandboxName: state.sandboxName,
    provider: state.provider,
    model: state.model,
    policyPresets: appliedPolicyPresets,
  });
  return { kind: "complete", policyPresets: appliedPolicyPresets };
}
