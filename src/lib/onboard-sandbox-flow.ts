// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "./web-search";

export interface SandboxFlowState<TAgent = unknown, TGpu = unknown> {
  gpu: TGpu;
  sandboxName: string | null;
  model: string;
  provider: string;
  preferredInferenceApi: string | null;
  webSearchConfig: WebSearchConfig | null;
  selectedMessagingChannels: string[];
  nimContainer: string | null;
  fromDockerfile: string | null;
  agent: TAgent;
  dangerouslySkipPermissions: boolean;
}

export interface SandboxFlowDeps<TAgent = unknown, TGpu = unknown> {
  resume: boolean;
  sessionMessagingChannels: string[] | null;
  sessionWebSearchConfig: WebSearchConfig | null;
  hasCompletedMessaging: boolean;
  hasCompletedSandbox: boolean;
  setupMessagingChannels: () => Promise<string[]>;
  configureWebSearch: (_existing: null) => Promise<WebSearchConfig | null>;
  ensureValidatedBraveSearchCredential: () => Promise<string | null>;
  getSandboxReuseState: (sandboxName: string | null) => string;
  removeSandbox: (sandboxName: string) => void;
  repairRecordedSandbox: (sandboxName: string) => void;
  createSandbox: (
    gpu: TGpu,
    model: string,
    provider: string,
    preferredInferenceApi: string | null,
    sandboxName: string | null,
    webSearchConfig: WebSearchConfig | null,
    messagingChannels: string[],
    fromDockerfile: string | null,
    agent: TAgent,
    dangerouslySkipPermissions: boolean,
  ) => Promise<string>;
  persistRegistryModelProvider: (sandboxName: string, patch: { model: string; provider: string }) => void;
  onNote: (message: string) => void;
  onSkip: (stepName: "messaging" | "sandbox", detail: string | null) => void;
  onStartStep: (
    stepName: "messaging" | "sandbox",
    updates?: { sandboxName?: string | null; provider?: string | null; model?: string | null },
  ) => void;
  onCompleteStep: (
    stepName: "messaging" | "sandbox",
    updates?: {
      sandboxName?: string | null;
      provider?: string | null;
      model?: string | null;
      messagingChannels?: string[];
      nimContainer?: string | null;
      webSearchConfig?: WebSearchConfig | null;
    },
  ) => void;
}

export interface SandboxFlowResult<TAgent = unknown, TGpu = unknown>
  extends SandboxFlowState<TAgent, TGpu> {}

export async function runSandboxProvisioningFlow<TAgent = unknown, TGpu = unknown>(
  initialState: SandboxFlowState<TAgent, TGpu>,
  deps: SandboxFlowDeps<TAgent, TGpu>,
): Promise<SandboxFlowResult<TAgent, TGpu>> {
  const state: SandboxFlowState<TAgent, TGpu> = {
    ...initialState,
    selectedMessagingChannels: [...initialState.selectedMessagingChannels],
  };

  const sandboxReuseState = deps.getSandboxReuseState(state.sandboxName);
  const webSearchConfigChanged =
    Boolean(deps.sessionWebSearchConfig) !== Boolean(state.webSearchConfig);
  const resumeSandbox =
    deps.hasCompletedSandbox && !webSearchConfigChanged && sandboxReuseState === "ready";

  if (resumeSandbox) {
    if (state.webSearchConfig) {
      deps.onNote("  [resume] Reusing Brave Search configuration already baked into the sandbox.");
    }
    deps.onSkip("sandbox", state.sandboxName);
    return state;
  }

  if (deps.hasCompletedSandbox) {
    if (webSearchConfigChanged) {
      deps.onNote("  [resume] Web Search configuration changed; recreating sandbox.");
      if (state.sandboxName) {
        deps.removeSandbox(state.sandboxName);
      }
    } else if (sandboxReuseState === "not_ready") {
      deps.onNote(
        `  [resume] Recorded sandbox '${state.sandboxName}' exists but is not ready; recreating it.`,
      );
      if (state.sandboxName) {
        deps.repairRecordedSandbox(state.sandboxName);
      }
    } else {
      deps.onNote("  [resume] Recorded sandbox state is unavailable; recreating it.");
      if (state.sandboxName) {
        deps.removeSandbox(state.sandboxName);
      }
    }
  }

  let nextWebSearchConfig = state.webSearchConfig;
  if (nextWebSearchConfig) {
    deps.onNote("  [resume] Revalidating Brave Search configuration for sandbox recreation.");
    const braveApiKey = await deps.ensureValidatedBraveSearchCredential();
    nextWebSearchConfig = braveApiKey ? { fetchEnabled: true } : null;
    if (nextWebSearchConfig) {
      deps.onNote("  [resume] Reusing Brave Search configuration.");
    }
  } else {
    nextWebSearchConfig = await deps.configureWebSearch(null);
  }

  const resumeMessaging =
    deps.resume && Array.isArray(deps.sessionMessagingChannels) && deps.hasCompletedMessaging;
  if (resumeMessaging && Array.isArray(deps.sessionMessagingChannels)) {
    state.selectedMessagingChannels = [...deps.sessionMessagingChannels];
    deps.onSkip("messaging", state.selectedMessagingChannels.join(", "));
  } else {
    deps.onStartStep("messaging", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
    });
    state.selectedMessagingChannels = await deps.setupMessagingChannels();
    deps.onCompleteStep("messaging", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
      messagingChannels: state.selectedMessagingChannels,
    });
  }

  deps.onStartStep("sandbox", {
    sandboxName: state.sandboxName,
    provider: state.provider,
    model: state.model,
  });
  const nextSandboxName = await deps.createSandbox(
    state.gpu,
    state.model,
    state.provider,
    state.preferredInferenceApi,
    state.sandboxName,
    nextWebSearchConfig,
    state.selectedMessagingChannels,
    state.fromDockerfile,
    state.agent,
    state.dangerouslySkipPermissions,
  );
  deps.persistRegistryModelProvider(nextSandboxName, {
    model: state.model,
    provider: state.provider,
  });
  deps.onCompleteStep("sandbox", {
    sandboxName: nextSandboxName,
    provider: state.provider,
    model: state.model,
    nimContainer: state.nimContainer,
    webSearchConfig: nextWebSearchConfig,
  });

  return {
    ...state,
    sandboxName: nextSandboxName,
    webSearchConfig: nextWebSearchConfig,
  };
}
