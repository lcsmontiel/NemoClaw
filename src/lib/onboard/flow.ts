// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export function createOnboardFlowHelpers(deps) {
  const {
    GATEWAY_NAME,
    agentOnboard,
    arePolicyPresetsApplied,
    buildSandboxConfigSyncScript,
    cleanupTempDir,
    configureWebSearch,
    createSandbox,
    ensureUsageNoticeConsent,
    ensureValidatedBraveSearchCredential,
    getGatewayReuseState,
    getOpenshellBinary,
    getResumeConfigConflicts,
    getSandboxReuseState,
    hydrateCredentialEnv,
    isInferenceRouteReady,
    isNonInteractive,
    isOpenclawReady,
    nim,
    note,
    onboardSession,
    openshellShellCommand,
    preflight,
    printDashboard,
    registry,
    repairRecordedSandbox,
    runCaptureOpenshell,
    setNonInteractiveFlag,
    setRecreateSandboxFlag,
    setupInference,
    setupMessagingChannels,
    setupNim,
    setupOpenclaw,
    setupPoliciesWithSelection,
    skippedStepMessage,
    startGateway,
    startRecordedStep,
    step,
    writeSandboxConfigSyncFile,
  } = deps;

  function applyOnboardFlags(opts = {}) {
    setNonInteractiveFlag(opts.nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1");
    setRecreateSandboxFlag(opts.recreateSandbox || process.env.NEMOCLAW_RECREATE_SANDBOX === "1");
    const dangerouslySkipPermissions =
      opts.dangerouslySkipPermissions || process.env.NEMOCLAW_DANGEROUSLY_SKIP_PERMISSIONS === "1";
    if (dangerouslySkipPermissions) {
      console.error("");
      console.error("  ⚠  --dangerously-skip-permissions: sandbox security restrictions disabled.");
      console.error("     Network:    all known endpoints open (no method/path filtering)");
      console.error("     Filesystem: sandbox home directory is writable");
      console.error("     Use for development/testing only.");
      console.error("");
    }
    delete process.env.OPENSHELL_GATEWAY;
    return {
      dangerouslySkipPermissions,
      requestedFromDockerfile:
        opts.fromDockerfile ||
        (isNonInteractive() ? process.env.NEMOCLAW_FROM_DOCKERFILE || null : null),
      resume: opts.resume === true,
    };
  }

  async function ensureUsageNoticeAccepted(opts = {}) {
    const noticeAccepted = await ensureUsageNoticeConsent({
      nonInteractive: isNonInteractive(),
      acceptedByFlag: opts.acceptThirdPartySoftware === true,
      writeLine: console.error,
    });
    if (!noticeAccepted) {
      process.exit(1);
    }
  }

  function buildOnboardLockCommand({ resume, requestedFromDockerfile }) {
    return `nemoclaw onboard${resume ? " --resume" : ""}${isNonInteractive() ? " --non-interactive" : ""}${requestedFromDockerfile ? ` --from ${requestedFromDockerfile}` : ""}`;
  }

  function acquireOnboardRunLock({ resume, requestedFromDockerfile }) {
    const lockResult = onboardSession.acquireOnboardLock(
      buildOnboardLockCommand({ resume, requestedFromDockerfile }),
    );
    if (!lockResult.acquired) {
      console.error("  Another NemoClaw onboarding run is already in progress.");
      if (lockResult.holderPid) {
        console.error(`  Lock holder PID: ${lockResult.holderPid}`);
      }
      if (lockResult.holderStartedAt) {
        console.error(`  Started: ${lockResult.holderStartedAt}`);
      }
      console.error(
        "  Wait for it to finish, or remove the stale lock if the previous run crashed:",
      );
      console.error(`    rm -f "${lockResult.lockFile}"`);
      process.exit(1);
    }

    let lockReleased = false;
    const releaseOnboardLock = () => {
      if (lockReleased) return;
      lockReleased = true;
      onboardSession.releaseOnboardLock();
    };
    process.once("exit", releaseOnboardLock);
    return releaseOnboardLock;
  }

  function printResumeConflicts(resumeConflicts) {
    for (const conflict of resumeConflicts) {
      if (conflict.field === "sandbox") {
        console.error(
          `  Resumable state belongs to sandbox '${conflict.recorded}', not '${conflict.requested}'.`,
        );
      } else if (conflict.field === "agent") {
        console.error(
          `  Session was started with agent '${conflict.recorded}', not '${conflict.requested}'.`,
        );
      } else if (conflict.field === "fromDockerfile") {
        if (!conflict.recorded) {
          console.error(
            `  Session was started without --from; add --from '${conflict.requested}' to resume it.`,
          );
        } else if (!conflict.requested) {
          console.error(
            `  Session was started with --from '${conflict.recorded}'; rerun with that path to resume it.`,
          );
        } else {
          console.error(
            `  Session was started with --from '${conflict.recorded}', not '${conflict.requested}'.`,
          );
        }
      } else {
        console.error(
          `  Resumable state recorded ${conflict.field} '${conflict.recorded}', not '${conflict.requested}'.`,
        );
      }
    }
    console.error("  Run: nemoclaw onboard              # start a fresh onboarding session");
    console.error("  Or rerun with the original settings to continue that session.");
    process.exit(1);
  }

  function resolveSessionDockerfile(session, requestedFromDockerfile) {
    const sessionFrom = session?.metadata?.fromDockerfile || null;
    return requestedFromDockerfile
      ? path.resolve(requestedFromDockerfile)
      : sessionFrom
        ? path.resolve(sessionFrom)
        : null;
  }

  async function loadOrCreateSession({ opts = {}, requestedFromDockerfile, resume }) {
    if (resume) {
      let session = onboardSession.loadSession();
      if (!session || session.resumable === false) {
        console.error("  No resumable onboarding session was found.");
        console.error("  Run: nemoclaw onboard");
        process.exit(1);
      }
      const fromDockerfile = resolveSessionDockerfile(session, requestedFromDockerfile);
      const resumeConflicts = getResumeConfigConflicts(session, {
        nonInteractive: isNonInteractive(),
        fromDockerfile: requestedFromDockerfile,
        agent: opts.agent || null,
      });
      if (resumeConflicts.length > 0) {
        printResumeConflicts(resumeConflicts);
      }
      onboardSession.updateSession((current) => {
        current.mode = isNonInteractive() ? "non-interactive" : "interactive";
        current.failure = null;
        current.status = "in_progress";
        return current;
      });
      session = onboardSession.loadSession();
      return { fromDockerfile, session };
    }

    const fromDockerfile = requestedFromDockerfile ? path.resolve(requestedFromDockerfile) : null;
    const session = onboardSession.saveSession(
      onboardSession.createSession({
        mode: isNonInteractive() ? "non-interactive" : "interactive",
        metadata: { gatewayName: "nemoclaw", fromDockerfile: fromDockerfile || null },
      }),
    );
    return { fromDockerfile, session };
  }

  function attachExitFailureRecorder(completionRef) {
    process.once("exit", (code) => {
      if (!completionRef.completed && code !== 0) {
        const current = onboardSession.loadSession();
        const failedStep = current?.lastStepStarted;
        if (failedStep) {
          onboardSession.markStepFailed(failedStep, "Onboarding exited before the step completed.");
        }
      }
    });
  }

  function printOnboardingHeader({ resume }) {
    console.log("");
    console.log("  NemoClaw Onboarding");
    if (isNonInteractive()) note("  (non-interactive mode)");
    if (resume) note("  (resume mode)");
    console.log("  ===================");
  }

  function resolveSelectedAgent(opts, session) {
    const agent = agentOnboard.resolveAgent({ agentFlag: opts.agent, session });
    if (agent) {
      onboardSession.updateSession((current) => {
        current.agent = agent.name;
        return current;
      });
    }
    return agent;
  }

  async function runPreflightPhase({ resume, session }) {
    const resumePreflight = resume && session?.steps?.preflight?.status === "complete";
    if (resumePreflight) {
      skippedStepMessage("preflight", "cached");
      return nim.detectGpu();
    }
    startRecordedStep("preflight");
    const gpu = await preflight();
    onboardSession.markStepComplete("preflight");
    return gpu;
  }

  function getLiveGatewayReuseState() {
    const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
    const gatewayInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    return getGatewayReuseState(gatewayStatus, gatewayInfo, activeGatewayInfo);
  }

  async function runGatewayPhase({ gpu, resume, session }) {
    const gatewayReuseState = getLiveGatewayReuseState();
    const canReuseHealthyGateway = gatewayReuseState === "healthy";
    const resumeGateway =
      resume && session?.steps?.gateway?.status === "complete" && canReuseHealthyGateway;
    if (resumeGateway) {
      skippedStepMessage("gateway", "running");
      return;
    }
    if (!resume && canReuseHealthyGateway) {
      skippedStepMessage("gateway", "running", "reuse");
      note("  Reusing healthy NemoClaw gateway.");
      return;
    }
    if (resume && session?.steps?.gateway?.status === "complete") {
      if (gatewayReuseState === "active-unnamed") {
        note("  [resume] Gateway is active but named metadata is missing; recreating it safely.");
      } else if (gatewayReuseState === "foreign-active") {
        note("  [resume] A different OpenShell gateway is active; NemoClaw will not reuse it.");
      } else if (gatewayReuseState === "stale") {
        note("  [resume] Recorded gateway is unhealthy; recreating it.");
      } else {
        note("  [resume] Recorded gateway state is unavailable; recreating it.");
      }
    }
    startRecordedStep("gateway");
    await startGateway(gpu);
    onboardSession.markStepComplete("gateway");
  }

  function createFlowState(session) {
    return {
      credentialEnv: session?.credentialEnv || null,
      endpointUrl: session?.endpointUrl || null,
      model: session?.model || null,
      nimContainer: session?.nimContainer || null,
      preferredInferenceApi: session?.preferredInferenceApi || null,
      provider: session?.provider || null,
      sandboxName: session?.sandboxName || null,
      webSearchConfig: session?.webSearchConfig || null,
    };
  }

  async function runProviderSelectionStep({ forceProviderSelection, gpu, resume, session, state }) {
    const resumeProviderSelection =
      !forceProviderSelection &&
      resume &&
      session?.steps?.provider_selection?.status === "complete" &&
      typeof state.provider === "string" &&
      typeof state.model === "string";
    if (resumeProviderSelection) {
      skippedStepMessage("provider_selection", `${state.provider} / ${state.model}`);
      hydrateCredentialEnv(state.credentialEnv);
      return state;
    }

    startRecordedStep("provider_selection", { sandboxName: state.sandboxName });
    const selection = await setupNim(gpu);
    const nextState = {
      ...state,
      credentialEnv: selection.credentialEnv,
      endpointUrl: selection.endpointUrl,
      model: selection.model,
      nimContainer: selection.nimContainer,
      preferredInferenceApi: selection.preferredInferenceApi,
      provider: selection.provider,
    };
    onboardSession.markStepComplete("provider_selection", {
      sandboxName: nextState.sandboxName,
      provider: nextState.provider,
      model: nextState.model,
      endpointUrl: nextState.endpointUrl,
      credentialEnv: nextState.credentialEnv,
      preferredInferenceApi: nextState.preferredInferenceApi,
      nimContainer: nextState.nimContainer,
    });
    return nextState;
  }

  async function runInferenceStep({ forceProviderSelection, resume, state }) {
    process.env.NEMOCLAW_OPENSHELL_BIN = getOpenshellBinary();
    const resumeInference =
      !forceProviderSelection &&
      resume &&
      typeof state.provider === "string" &&
      typeof state.model === "string" &&
      isInferenceRouteReady(state.provider, state.model);
    if (resumeInference) {
      skippedStepMessage("inference", `${state.provider} / ${state.model}`);
      if (state.nimContainer) {
        registry.updateSandbox(state.sandboxName, { nimContainer: state.nimContainer });
      }
      onboardSession.markStepComplete("inference", {
        sandboxName: state.sandboxName,
        provider: state.provider,
        model: state.model,
        nimContainer: state.nimContainer,
      });
      return { retrySelection: false, state };
    }

    startRecordedStep("inference", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
    });
    const inferenceResult = await setupInference(
      GATEWAY_NAME,
      state.model,
      state.provider,
      state.endpointUrl,
      state.credentialEnv,
    );
    delete process.env.NVIDIA_API_KEY;
    if (inferenceResult?.retry === "selection") {
      return { retrySelection: true, state };
    }
    if (state.nimContainer) {
      registry.updateSandbox(state.sandboxName, { nimContainer: state.nimContainer });
    }
    onboardSession.markStepComplete("inference", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
      nimContainer: state.nimContainer,
    });
    return { retrySelection: false, state };
  }

  async function runProviderAndInferencePhases({ gpu, resume, session }) {
    let forceProviderSelection = false;
    let state = createFlowState(session);
    while (true) {
      state = await runProviderSelectionStep({
        forceProviderSelection,
        gpu,
        resume,
        session,
        state,
      });
      const inferenceStep = await runInferenceStep({
        forceProviderSelection,
        resume,
        state,
      });
      if (!inferenceStep.retrySelection) {
        return inferenceStep.state;
      }
      forceProviderSelection = true;
    }
  }

  async function runWebSearchPhase(webSearchConfig) {
    if (webSearchConfig) {
      note("  [resume] Revalidating Brave Search configuration.");
      const braveApiKey = await ensureValidatedBraveSearchCredential();
      if (braveApiKey) {
        const nextConfig = { fetchEnabled: true };
        onboardSession.updateSession((current) => {
          current.webSearchConfig = nextConfig;
          return current;
        });
        note("  [resume] Reusing Brave Search configuration.");
        return nextConfig;
      }
      const nextConfig = await configureWebSearch(null);
      onboardSession.updateSession((current) => {
        current.webSearchConfig = nextConfig;
        return current;
      });
      return nextConfig;
    }

    const nextConfig = await configureWebSearch(webSearchConfig);
    onboardSession.updateSession((current) => {
      current.webSearchConfig = nextConfig;
      return current;
    });
    return nextConfig;
  }

  async function runSandboxPhase({
    agent,
    dangerouslySkipPermissions,
    fromDockerfile,
    gpu,
    resume,
    session,
    state,
  }) {
    let selectedMessagingChannels = [];
    const sandboxReuseState = getSandboxReuseState(state.sandboxName);
    const resumeSandbox =
      resume && session?.steps?.sandbox?.status === "complete" && sandboxReuseState === "ready";
    if (resumeSandbox) {
      skippedStepMessage("sandbox", state.sandboxName);
      return { selectedMessagingChannels, state };
    }

    if (resume && session?.steps?.sandbox?.status === "complete") {
      if (sandboxReuseState === "not_ready") {
        note(
          `  [resume] Recorded sandbox '${state.sandboxName}' exists but is not ready; recreating it.`,
        );
        repairRecordedSandbox(state.sandboxName);
      } else {
        note("  [resume] Recorded sandbox state is unavailable; recreating it.");
        if (state.sandboxName) {
          registry.removeSandbox(state.sandboxName);
        }
      }
    }

    startRecordedStep("sandbox", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
    });
    selectedMessagingChannels = await setupMessagingChannels();
    onboardSession.updateSession((current) => {
      current.messagingChannels = selectedMessagingChannels;
      return current;
    });
    const sandboxName = await createSandbox(
      gpu,
      state.model,
      state.provider,
      state.preferredInferenceApi,
      state.sandboxName,
      state.webSearchConfig,
      selectedMessagingChannels,
      fromDockerfile,
      agent,
      dangerouslySkipPermissions,
    );
    const nextState = { ...state, sandboxName };
    onboardSession.markStepComplete("sandbox", {
      sandboxName: nextState.sandboxName,
      provider: nextState.provider,
      model: nextState.model,
      nimContainer: nextState.nimContainer,
    });
    return { selectedMessagingChannels, state: nextState };
  }

  async function runOpenclawPhase({ agent, resume, session, state }) {
    if (agent) {
      await agentOnboard.handleAgentSetup(
        state.sandboxName,
        state.model,
        state.provider,
        agent,
        resume,
        session,
        {
          step,
          runCaptureOpenshell,
          openshellShellCommand,
          buildSandboxConfigSyncScript,
          writeSandboxConfigSyncFile,
          cleanupTempDir,
          startRecordedStep,
          skippedStepMessage,
        },
      );
      return;
    }

    const resumeOpenclaw = resume && state.sandboxName && isOpenclawReady(state.sandboxName);
    if (resumeOpenclaw) {
      skippedStepMessage("openclaw", state.sandboxName);
      onboardSession.markStepComplete("openclaw", {
        sandboxName: state.sandboxName,
        provider: state.provider,
        model: state.model,
      });
      return;
    }

    startRecordedStep("openclaw", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
    });
    await setupOpenclaw(state.sandboxName, state.model, state.provider);
    onboardSession.markStepComplete("openclaw", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
    });
  }

  async function runPoliciesPhase({
    dangerouslySkipPermissions,
    resume,
    selectedMessagingChannels,
    session,
    state,
  }) {
    const recordedPolicyPresets = Array.isArray(session?.policyPresets)
      ? session.policyPresets
      : null;
    if (dangerouslySkipPermissions) {
      step(8, 8, "Policy presets");
      console.log("  Skipped — --dangerously-skip-permissions applies permissive base policy.");
      onboardSession.markStepComplete("policies", {
        sandboxName: state.sandboxName,
        provider: state.provider,
        model: state.model,
        policyPresets: [],
      });
      return;
    }

    const resumePolicies =
      resume &&
      state.sandboxName &&
      arePolicyPresetsApplied(state.sandboxName, recordedPolicyPresets || []);
    if (resumePolicies) {
      skippedStepMessage("policies", (recordedPolicyPresets || []).join(", "));
      onboardSession.markStepComplete("policies", {
        sandboxName: state.sandboxName,
        provider: state.provider,
        model: state.model,
        policyPresets: recordedPolicyPresets || [],
      });
      return;
    }

    startRecordedStep("policies", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
      policyPresets: recordedPolicyPresets || [],
    });
    const appliedPolicyPresets = await setupPoliciesWithSelection(state.sandboxName, {
      selectedPresets:
        resume &&
        session?.steps?.policies?.status !== "complete" &&
        Array.isArray(recordedPolicyPresets) &&
        recordedPolicyPresets.length > 0
          ? recordedPolicyPresets
          : null,
      enabledChannels: selectedMessagingChannels,
      webSearchConfig: state.webSearchConfig,
      onSelection: (policyPresets) => {
        onboardSession.updateSession((current) => {
          current.policyPresets = policyPresets;
          return current;
        });
      },
    });
    onboardSession.markStepComplete("policies", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
      policyPresets: appliedPolicyPresets,
    });
  }

  function finalizeOnboardRun({ agent, completionRef, state }) {
    onboardSession.completeSession({
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
    });
    completionRef.completed = true;
    printDashboard(state.sandboxName, state.model, state.provider, state.nimContainer, agent);
  }

  async function onboard(opts = {}) {
    const flags = applyOnboardFlags(opts);
    await ensureUsageNoticeAccepted(opts);
    const releaseOnboardLock = acquireOnboardRunLock(flags);
    const completionRef = { completed: false };

    try {
      const { fromDockerfile, session } = await loadOrCreateSession({
        opts,
        requestedFromDockerfile: flags.requestedFromDockerfile,
        resume: flags.resume,
      });
      attachExitFailureRecorder(completionRef);
      printOnboardingHeader(flags);

      const agent = resolveSelectedAgent(opts, session);
      const gpu = await runPreflightPhase({ resume: flags.resume, session });
      await runGatewayPhase({ gpu, resume: flags.resume, session });

      let state = await runProviderAndInferencePhases({
        gpu,
        resume: flags.resume,
        session,
      });
      state = { ...state, webSearchConfig: await runWebSearchPhase(state.webSearchConfig) };

      const sandboxPhase = await runSandboxPhase({
        agent,
        dangerouslySkipPermissions: flags.dangerouslySkipPermissions,
        fromDockerfile,
        gpu,
        resume: flags.resume,
        session,
        state,
      });
      state = sandboxPhase.state;

      await runOpenclawPhase({ agent, resume: flags.resume, session, state });
      await runPoliciesPhase({
        dangerouslySkipPermissions: flags.dangerouslySkipPermissions,
        resume: flags.resume,
        selectedMessagingChannels: sandboxPhase.selectedMessagingChannels,
        session,
        state,
      });
      finalizeOnboardRun({ agent, completionRef, state });
    } finally {
      releaseOnboardLock();
    }
  }

  return {
    onboard,
  };
}
