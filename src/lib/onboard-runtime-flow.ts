// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface RuntimeSetupState<TAgent = unknown> {
  sandboxName: string;
  model: string;
  provider: string;
  agent: TAgent | null;
  resume: boolean;
  session: unknown;
}

export interface RuntimeSetupDeps<TAgent = unknown> {
  hasCompletedRuntimeSetup: boolean;
  handleAgentSetup: (
    sandboxName: string,
    model: string,
    provider: string,
    agent: TAgent,
    resume: boolean,
    session: unknown,
  ) => Promise<void>;
  isOpenclawReady: (sandboxName: string) => boolean;
  setupOpenclaw: (sandboxName: string, model: string, provider: string) => Promise<void>;
  onSkip: (stepName: "openclaw", detail: string) => void;
  onStartStep: (
    stepName: "openclaw",
    updates?: { sandboxName?: string; provider?: string; model?: string },
  ) => void;
  onCompleteStep: (
    stepName: "openclaw",
    updates?: { sandboxName?: string; provider?: string; model?: string },
  ) => void;
  onSkipSiblingStep: (stepName: "openclaw" | "agent_setup") => void;
}

export async function runRuntimeSetupFlow<TAgent = unknown>(
  state: RuntimeSetupState<TAgent>,
  deps: RuntimeSetupDeps<TAgent>,
): Promise<void> {
  if (state.agent) {
    await deps.handleAgentSetup(
      state.sandboxName,
      state.model,
      state.provider,
      state.agent,
      state.resume,
      state.session,
    );
    deps.onSkipSiblingStep("openclaw");
    return;
  }

  const resumeOpenclaw = deps.hasCompletedRuntimeSetup && deps.isOpenclawReady(state.sandboxName);
  if (resumeOpenclaw) {
    deps.onSkip("openclaw", state.sandboxName);
    deps.onCompleteStep("openclaw", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
    });
  } else {
    deps.onStartStep("openclaw", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
    });
    await deps.setupOpenclaw(state.sandboxName, state.model, state.provider);
    deps.onCompleteStep("openclaw", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
    });
  }
  deps.onSkipSiblingStep("agent_setup");
}
