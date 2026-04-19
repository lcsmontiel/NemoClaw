// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runSetupInference } from "./onboard-inference-provider";
import {
  getGatewayStartEnv as buildGatewayStartEnv,
  recoverGatewayRuntime as recoverGatewayRuntimeWithDeps,
  startGatewayWithOptions as startGatewayWithOptionsWithDeps,
} from "./onboard-gateway-runtime";
import { setupMessagingChannels as setupMessagingChannelsWithDeps } from "./onboard-messaging";
import { runSetupNim as setupNimWithDeps } from "./onboard-nim-setup";
import { setupOpenclaw as setupOpenclawWithDeps } from "./onboard-openclaw-setup";
import { getSuggestedPolicyPresets as getSuggestedPolicyPresetsWithDeps } from "./onboard-policy-suggestions";
import { runOnboardPreflight } from "./onboard-preflight-run";
import { checkTelegramReachability as checkTelegramReachabilityWithDeps } from "./onboard-telegram";

export function createHostGatewayApi(input: any) {
  const preflight = async () =>
    runOnboardPreflight({
      step: input.step,
      assessHost: input.assessHost,
      planHostRemediation: input.planHostRemediation,
      printRemediationActions: input.printRemediationActions,
      isOpenshellInstalled: input.isOpenshellInstalled,
      installOpenshell: input.installOpenshell,
      getInstalledOpenshellVersion: input.getInstalledOpenshellVersion,
      runCaptureOpenshell: input.runCaptureOpenshell,
      getBlueprintMinOpenshellVersion: input.getBlueprintMinOpenshellVersion,
      getBlueprintMaxOpenshellVersion: input.getBlueprintMaxOpenshellVersion,
      versionGte: input.versionGte,
      getGatewayReuseState: input.getGatewayReuseState,
      verifyGatewayContainerRunning: input.verifyGatewayContainerRunning,
      runOpenshell: input.runOpenshell,
      destroyGateway: input.destroyGateway,
      clearRegistryAll: input.clearRegistryAll,
      run: input.run,
      runCapture: input.runCapture,
      checkPortAvailable: input.checkPortAvailable,
      sleep: input.sleep,
      getPortConflictServiceHints: input.getPortConflictServiceHints,
      getMemoryInfo: input.getMemoryInfo,
      ensureSwap: input.ensureSwap,
      isNonInteractive: input.isNonInteractive,
      prompt: input.prompt,
      nimDetectGpu: input.nimDetectGpu,
      processPlatform: input.processPlatform,
      gatewayName: input.gatewayName,
      dashboardPort: input.dashboardPort,
      gatewayPort: input.gatewayPort,
    });

  /** Start the OpenShell gateway with retry logic and post-start health polling. */
  const startGatewayWithOptions = async (_gpu: unknown, { exitOnFailure = true } = {}) =>
    startGatewayWithOptionsWithDeps(
      _gpu,
      {
        gatewayName: input.gatewayName,
        gatewayPort: input.gatewayPort,
        scriptsDir: input.scriptsDir,
        processEnv: input.processEnv,
        processArch: input.processArch,
        showHeader: () => {
          input.step(2, 8, "Starting OpenShell gateway");
        },
        log: input.log,
        error: input.error,
        exit: input.exit,
        openshellShellCommand: (args: string[]) => input.openshellShellCommand(args),
        streamGatewayStart: input.streamGatewayStart,
        runCaptureOpenshell: input.runCaptureOpenshell,
        runOpenshell: input.runOpenshell,
        isGatewayHealthy: input.isGatewayHealthy,
        hasStaleGateway: input.hasStaleGateway,
        redact: input.redact,
        compactText: input.compactText,
        envInt: input.envInt,
        sleep: input.sleep,
        getInstalledOpenshellVersion: () => input.getInstalledOpenshellVersion(),
        getContainerRuntime: input.getContainerRuntime,
        shouldPatchCoredns: input.shouldPatchCoredns,
        run: input.run,
        destroyGateway: input.destroyGateway,
        pruneKnownHostsEntries: input.pruneKnownHostsEntries,
      },
      { exitOnFailure },
    );

  const startGateway = async (_gpu: unknown) =>
    startGatewayWithOptions(_gpu, { exitOnFailure: true });

  const startGatewayForRecovery = async (_gpu: unknown) =>
    startGatewayWithOptions(_gpu, { exitOnFailure: false });

  const getGatewayStartEnv = () => buildGatewayStartEnv(input.getInstalledOpenshellVersion());

  const recoverGatewayRuntime = async () =>
    recoverGatewayRuntimeWithDeps({
      gatewayName: input.gatewayName,
      gatewayPort: input.gatewayPort,
      processEnv: input.processEnv,
      runCaptureOpenshell: input.runCaptureOpenshell,
      runOpenshell: input.runOpenshell,
      isSelectedGateway: input.isSelectedGateway,
      getGatewayStartEnv,
      envInt: input.envInt,
      sleep: input.sleep,
      redact: input.redact,
      compactText: input.compactText,
      getContainerRuntime: input.getContainerRuntime,
      shouldPatchCoredns: input.shouldPatchCoredns,
      run: input.run,
      scriptsDir: input.scriptsDir,
      error: input.error,
    });

  return {
    preflight,
    startGatewayWithOptions,
    startGateway,
    startGatewayForRecovery,
    getGatewayStartEnv,
    recoverGatewayRuntime,
  };
}

export function createInferenceRuntimeApi(input: any) {
  const setupNim = async (gpu: unknown) =>
    setupNimWithDeps(gpu, {
      step: input.step,
      remoteProviderConfig: input.remoteProviderConfig,
      runCapture: input.runCapture,
      ollamaPort: input.ollamaPort,
      vllmPort: input.vllmPort,
      ollamaProxyPort: input.ollamaProxyPort,
      experimental: input.experimental,
      isNonInteractive: input.isNonInteractive,
      getNonInteractiveProvider: input.getNonInteractiveProvider,
      getNonInteractiveModel: input.getNonInteractiveModel,
      note: input.note,
      prompt: input.prompt,
      getNavigationChoice: input.getNavigationChoice,
      exitOnboardFromPrompt: input.exitOnboardFromPrompt,
      normalizeProviderBaseUrl: input.normalizeProviderBaseUrl,
      validateNvidiaApiKeyValue: input.validateNvidiaApiKeyValue,
      ensureApiKey: input.ensureApiKey,
      defaultCloudModel: input.defaultCloudModel,
      promptCloudModel: input.promptCloudModel,
      ensureNamedCredential: input.ensureNamedCredential,
      getProbeAuthMode: input.getProbeAuthMode,
      validateOpenAiLikeModel: input.validateOpenAiLikeModel,
      getCredential: input.getCredential,
      validateAnthropicModel: input.validateAnthropicModel,
      anthropicEndpointUrl: input.anthropicEndpointUrl,
      promptRemoteModel: input.promptRemoteModel,
      promptInputModel: input.promptInputModel,
      backToSelection: input.backToSelection,
      validateCustomOpenAiLikeSelection: input.validateCustomOpenAiLikeSelection,
      validateCustomAnthropicSelection: input.validateCustomAnthropicSelection,
      validateAnthropicSelectionWithRetryMessage: input.validateAnthropicSelectionWithRetryMessage,
      validateOpenAiLikeSelection: input.validateOpenAiLikeSelection,
      shouldRequireResponsesToolCalling: input.shouldRequireResponsesToolCalling,
      shouldSkipResponsesProbe: input.shouldSkipResponsesProbe,
      nim: input.nim,
      gatewayName: input.gatewayName,
      getLocalProviderBaseUrl: input.getLocalProviderBaseUrl,
      getLocalProviderValidationBaseUrl: input.getLocalProviderValidationBaseUrl,
      processPlatform: input.processPlatform,
      validateLocalProvider: input.validateLocalProvider,
      isWsl: input.isWsl,
      run: input.run,
      sleep: input.sleep,
      printOllamaExposureWarning: input.printOllamaExposureWarning,
      startOllamaAuthProxy: input.startOllamaAuthProxy,
      getOllamaModelOptions: input.getOllamaModelOptions,
      getDefaultOllamaModel: input.getDefaultOllamaModel,
      promptOllamaModel: input.promptOllamaModel,
      prepareOllamaModel: input.prepareOllamaModel,
      isSafeModelId: input.isSafeModelId,
    });

  const setupInference = async (
    sandboxName: string,
    model: string,
    provider: string,
    endpointUrl: string | null = null,
    credentialEnv: string | null = null,
  ) =>
    runSetupInference(sandboxName, model, provider, endpointUrl, credentialEnv, {
      step: input.step,
      runOpenshell: input.runOpenshell,
      gatewayName: input.gatewayName,
      remoteProviderConfig: input.remoteProviderConfig,
      hydrateCredentialEnv: input.hydrateCredentialEnv,
      upsertProvider: input.upsertProvider,
      isNonInteractive: input.isNonInteractive,
      promptValidationRecovery: input.promptValidationRecovery,
      classifyApplyFailure: input.classifyApplyFailure,
      compactText: input.compactText,
      redact: input.redact,
      validateLocalProvider: input.validateLocalProvider,
      getLocalProviderBaseUrl: input.getLocalProviderBaseUrl,
      localInferenceTimeoutSecs: input.localInferenceTimeoutSecs,
      ensureOllamaAuthProxy: input.ensureOllamaAuthProxy,
      getOllamaProxyToken: input.getOllamaProxyToken,
      persistProxyToken: input.persistProxyToken,
      isWsl: input.isWsl,
      getOllamaWarmupCommand: input.getOllamaWarmupCommand,
      validateOllamaModel: input.validateOllamaModel,
      verifyInferenceRoute: input.verifyInferenceRoute,
      updateSandbox: input.updateSandbox,
      processPlatform: input.processPlatform,
      run: input.run,
    });

  const checkTelegramReachability = async (token: string) =>
    checkTelegramReachabilityWithDeps(token, {
      runCurlProbe: input.runCurlProbe,
      isNonInteractive: input.isNonInteractive,
      promptOrDefault: input.promptOrDefault,
      log: input.log,
      error: input.error,
      exit: input.exit,
    });

  const setupMessagingChannels = async () =>
    setupMessagingChannelsWithDeps({
      step: input.step,
      isNonInteractive: input.isNonInteractive,
      note: input.note,
      getCredential: input.getCredential,
      normalizeCredentialValue: input.normalizeCredentialValue,
      prompt: input.prompt,
      promptOrDefault: input.promptOrDefault,
      saveCredential: input.saveCredential,
      checkTelegramReachability,
      env: input.env,
      input: input.stdin,
      output: input.stderr,
    });

  const getSuggestedPolicyPresets = (options: any = {}) =>
    getSuggestedPolicyPresetsWithDeps({
      enabledChannels: options.enabledChannels ?? null,
      webSearchConfig: options.webSearchConfig ?? null,
      provider: options.provider ?? null,
      getCredential: input.getCredential,
      env: input.env,
      isInteractiveTty: input.isInteractiveTty,
      isNonInteractive: input.isNonInteractive(),
      note: input.noteLog,
    });

  const setupOpenclaw = async (sandboxName: string, model: string, provider: string) =>
    setupOpenclawWithDeps(sandboxName, model, provider, {
      step: input.step,
      getProviderSelectionConfig: input.getProviderSelectionConfig,
      writeSandboxConfigSyncFile: input.writeSandboxConfigSyncFile,
      openshellShellCommand: input.openshellShellCommand,
      shellQuote: input.shellQuote,
      run: input.run,
      cleanupTempDir: input.cleanupTempDir,
      fetchGatewayAuthTokenFromSandbox: input.fetchGatewayAuthTokenFromSandbox,
      log: input.log,
      secureTempFile: input.secureTempFile,
    });

  return {
    setupNim,
    setupInference,
    checkTelegramReachability,
    setupMessagingChannels,
    getSuggestedPolicyPresets,
    setupOpenclaw,
  };
}
