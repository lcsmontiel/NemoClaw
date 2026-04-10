// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createOnboardSandboxHelpers(deps) {
  const {
    CONTROL_UI_PORT,
    DISCORD_SNOWFLAKE_RE,
    GATEWAY_NAME,
    ROOT,
    SCRIPTS,
    MESSAGING_CHANNELS,
    REMOTE_PROVIDER_CONFIG,
    agentOnboard,
    classifySandboxCreateFailure,
    ensureDashboardForward,
    fetchGatewayAuthTokenFromSandbox,
    formatEnvAssignment,
    getCredential,
    getSandboxStateFromOutputs,
    isNonInteractive,
    isRecreateSandbox,
    isSandboxReady,
    normalizeCredentialValue,
    note,
    openshellShellCommand,
    patchStagedDockerfile,
    printSandboxCreateRecoveryHints,
    promptOrDefault,
    providerExistsInGateway,
    registry,
    run,
    runCapture,
    runCaptureOpenshell,
    runOpenshell,
    secureTempFile,
    shellQuote,
    sleep,
    stageOptimizedSandboxBuildContext,
    step,
    streamSandboxCreate,
    upsertMessagingProviders,
    webSearch,
  } = deps;

  function getSandboxReuseState(sandboxName) {
    if (!sandboxName) return "missing";
    const getOutput = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
    const listOutput = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    return getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
  }

  function repairRecordedSandbox(sandboxName) {
    if (!sandboxName) return;
    note(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
    runOpenshell(["forward", "stop", "18789"], { ignoreError: true });
    runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  function sandboxExistsInGateway(sandboxName) {
    const output = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
    return Boolean(output);
  }

  function pruneStaleSandboxEntry(sandboxName) {
    const existing = registry.getSandbox(sandboxName);
    const liveExists = sandboxExistsInGateway(sandboxName);
    if (existing && !liveExists) {
      registry.removeSandbox(sandboxName);
    }
    return liveExists;
  }

  function buildSandboxConfigSyncScript(selectionConfig) {
    return `
set -euo pipefail
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
exit
`.trim();
  }

  function isOpenclawReady(sandboxName) {
    return Boolean(fetchGatewayAuthTokenFromSandbox(sandboxName));
  }

  function writeSandboxConfigSyncFile(script) {
    const scriptFile = secureTempFile("nemoclaw-sync", ".sh");
    fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o600 });
    return scriptFile;
  }

  function waitForSandboxReady(sandboxName, attempts = 10, delaySeconds = 2) {
    for (let i = 0; i < attempts; i += 1) {
      const podPhase = runCaptureOpenshell(
        [
          "doctor",
          "exec",
          "--",
          "kubectl",
          "-n",
          "openshell",
          "get",
          "pod",
          sandboxName,
          "-o",
          "jsonpath={.status.phase}",
        ],
        { ignoreError: true },
      );
      if (podPhase === "Running") return true;
      sleep(delaySeconds);
    }
    return false;
  }

  async function promptValidatedSandboxName() {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const nameAnswer = await promptOrDefault(
        "  Sandbox name (lowercase, starts with letter, hyphens ok) [my-assistant]: ",
        "NEMOCLAW_SANDBOX_NAME",
        "my-assistant",
      );
      const sandboxName = (nameAnswer || "my-assistant").trim().toLowerCase();

      if (/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName)) {
        return sandboxName;
      }

      console.error(`  Invalid sandbox name: '${sandboxName}'`);
      if (/^[0-9]/.test(sandboxName)) {
        console.error("  Names must start with a letter, not a digit.");
      } else {
        console.error("  Names must be lowercase, contain only letters, numbers, and hyphens,");
        console.error("  must start with a letter, and end with a letter or number.");
      }

      if (isNonInteractive()) {
        process.exit(1);
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        console.error("  Please try again.\n");
      }
    }

    console.error("  Too many invalid attempts.");
    process.exit(1);
  }

  function getMessagingToken(envKey) {
    return getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;
  }

  function getEnabledMessagingEnvKeys(enabledChannels) {
    if (enabledChannels == null) return null;
    return new Set(
      MESSAGING_CHANNELS.filter((channel) => enabledChannels.includes(channel.name)).map(
        (channel) => channel.envKey,
      ),
    );
  }

  function buildMessagingTokenDefs(sandboxName, enabledChannels) {
    const enabledEnvKeys = getEnabledMessagingEnvKeys(enabledChannels);
    return [
      {
        name: `${sandboxName}-discord-bridge`,
        envKey: "DISCORD_BOT_TOKEN",
        token: getMessagingToken("DISCORD_BOT_TOKEN"),
      },
      {
        name: `${sandboxName}-slack-bridge`,
        envKey: "SLACK_BOT_TOKEN",
        token: getMessagingToken("SLACK_BOT_TOKEN"),
      },
      {
        name: `${sandboxName}-telegram-bridge`,
        envKey: "TELEGRAM_BOT_TOKEN",
        token: getMessagingToken("TELEGRAM_BOT_TOKEN"),
      },
    ].filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey));
  }

  function shouldMigrateMessagingProviders(messagingTokenDefs) {
    const hasMessagingTokens = messagingTokenDefs.some(({ token }) => !!token);
    return (
      hasMessagingTokens &&
      messagingTokenDefs.some(({ name, token }) => token && !providerExistsInGateway(name))
    );
  }

  async function maybeReuseExistingSandbox({ chatUiUrl, messagingTokenDefs, sandboxName }) {
    const liveExists = pruneStaleSandboxEntry(sandboxName);
    if (!liveExists) {
      return { recreate: false, reused: false };
    }

    const existingSandboxState = getSandboxReuseState(sandboxName);
    const needsProviderMigration = shouldMigrateMessagingProviders(messagingTokenDefs);

    if (!isRecreateSandbox() && !needsProviderMigration) {
      if (isNonInteractive()) {
        if (existingSandboxState === "ready") {
          upsertMessagingProviders(messagingTokenDefs);
          note(`  [non-interactive] Sandbox '${sandboxName}' exists and is ready — reusing it`);
          note("  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to force recreation.");
          ensureDashboardForward(sandboxName, chatUiUrl);
          return { recreate: false, reused: true };
        }
        console.error(`  Sandbox '${sandboxName}' already exists but is not ready.`);
        console.error("  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to overwrite.");
        process.exit(1);
      }

      if (existingSandboxState === "ready") {
        console.log(`  Sandbox '${sandboxName}' already exists.`);
        console.log("  Choosing 'n' will delete the existing sandbox and create a new one.");
        const answer = await promptOrDefault("  Reuse existing sandbox? [Y/n]: ", null, "y");
        const normalizedAnswer = answer.trim().toLowerCase();
        if (normalizedAnswer !== "n" && normalizedAnswer !== "no") {
          upsertMessagingProviders(messagingTokenDefs);
          ensureDashboardForward(sandboxName, chatUiUrl);
          return { recreate: false, reused: true };
        }
      } else {
        console.log(`  Sandbox '${sandboxName}' exists but is not ready.`);
        console.log("  Selecting 'n' will abort onboarding.");
        const answer = await promptOrDefault(
          "  Delete it and create a new one? [Y/n]: ",
          null,
          "y",
        );
        const normalizedAnswer = answer.trim().toLowerCase();
        if (normalizedAnswer === "n" || normalizedAnswer === "no") {
          console.log("  Aborting onboarding.");
          process.exit(1);
        }
      }
    }

    if (needsProviderMigration) {
      console.log(`  Sandbox '${sandboxName}' exists but messaging providers are not attached.`);
      console.log("  Recreating to ensure credentials flow through the provider pipeline.");
    } else if (existingSandboxState === "ready") {
      note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
    } else {
      note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
    }

    note(`  Deleting and recreating sandbox '${sandboxName}'...`);
    runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    registry.removeSandbox(sandboxName);
    return { recreate: true, reused: false };
  }

  function stageCustomBuildContext(fromDockerfile) {
    const fromResolved = path.resolve(fromDockerfile);
    if (!fs.existsSync(fromResolved)) {
      console.error(`  Custom Dockerfile not found: ${fromResolved}`);
      process.exit(1);
    }
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    fs.cpSync(path.dirname(fromResolved), buildCtx, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return !["node_modules", ".git", ".venv", "__pycache__"].includes(base);
      },
    });
    if (path.basename(fromResolved) !== "Dockerfile") {
      fs.copyFileSync(fromResolved, stagedDockerfile);
    }
    console.log(`  Using custom Dockerfile: ${fromResolved}`);
    return { buildCtx, stagedDockerfile };
  }

  function stageSandboxBuildContext({ agent, fromDockerfile }) {
    if (fromDockerfile) {
      return stageCustomBuildContext(fromDockerfile);
    }
    if (agent) {
      return agentOnboard.createAgentSandbox(agent);
    }
    return stageOptimizedSandboxBuildContext(ROOT);
  }

  function resolveBasePolicyPath({ agent, dangerouslySkipPermissions }) {
    const globalPermissivePath = path.join(
      ROOT,
      "nemoclaw-blueprint",
      "policies",
      "openclaw-sandbox-permissive.yaml",
    );
    if (dangerouslySkipPermissions) {
      const agentPermissive = agent && agentOnboard.getAgentPermissivePolicyPath(agent);
      return agentPermissive || globalPermissivePath;
    }
    const defaultPolicyPath = path.join(
      ROOT,
      "nemoclaw-blueprint",
      "policies",
      "openclaw-sandbox.yaml",
    );
    return (agent && agentOnboard.getAgentPolicyPath(agent)) || defaultPolicyPath;
  }

  function buildSandboxCreateArgs({ basePolicyPath, buildCtx, sandboxName }) {
    return ["--from", `${buildCtx}/Dockerfile`, "--name", sandboxName, "--policy", basePolicyPath];
  }

  function ensureBraveCredentialAvailable(webSearchConfig) {
    if (webSearchConfig && !getCredential(webSearch.BRAVE_API_KEY_ENV)) {
      console.error(
        "  Brave Search is enabled, but BRAVE_API_KEY is not available in this process.",
      );
      console.error(
        "  Re-run with BRAVE_API_KEY set, or disable Brave Search before recreating the sandbox.",
      );
      process.exit(1);
    }
  }

  function buildActiveMessagingChannels(messagingTokenDefs) {
    return messagingTokenDefs
      .filter(({ token }) => !!token)
      .map(({ envKey }) => {
        if (envKey === "DISCORD_BOT_TOKEN") return "discord";
        if (envKey === "SLACK_BOT_TOKEN") return "slack";
        if (envKey === "TELEGRAM_BOT_TOKEN") return "telegram";
        return null;
      })
      .filter(Boolean);
  }

  function buildMessagingAllowedIds(messagingTokenDefs) {
    const messagingAllowedIds = {};
    const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
    for (const channel of MESSAGING_CHANNELS) {
      if (
        enabledTokenEnvKeys.has(channel.envKey) &&
        channel.allowIdsMode === "dm" &&
        channel.userIdEnvKey &&
        process.env[channel.userIdEnvKey]
      ) {
        const ids = process.env[channel.userIdEnvKey]
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        if (ids.length > 0) {
          messagingAllowedIds[channel.name] = ids;
        }
      }
    }
    return messagingAllowedIds;
  }

  function buildDiscordGuilds(messagingTokenDefs) {
    const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
    const discordGuilds = {};
    if (!enabledTokenEnvKeys.has("DISCORD_BOT_TOKEN")) {
      return discordGuilds;
    }

    const serverIds = (process.env.DISCORD_SERVER_IDS || process.env.DISCORD_SERVER_ID || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const userIds = (process.env.DISCORD_ALLOWED_IDS || process.env.DISCORD_USER_ID || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const serverId of serverIds) {
      if (!DISCORD_SNOWFLAKE_RE.test(serverId)) {
        console.warn(`  Warning: Discord server ID '${serverId}' does not look like a snowflake.`);
      }
    }
    for (const userId of userIds) {
      if (!DISCORD_SNOWFLAKE_RE.test(userId)) {
        console.warn(`  Warning: Discord user ID '${userId}' does not look like a snowflake.`);
      }
    }
    const requireMention = process.env.DISCORD_REQUIRE_MENTION !== "0";
    for (const serverId of serverIds) {
      discordGuilds[serverId] = {
        requireMention,
        ...(userIds.length > 0 ? { users: userIds } : {}),
      };
    }
    return discordGuilds;
  }

  function buildSandboxRuntimeEnv(chatUiUrl) {
    const envArgs = [formatEnvAssignment("CHAT_UI_URL", chatUiUrl)];
    const blockedSandboxEnvNames = new Set([
      ...Object.values(REMOTE_PROVIDER_CONFIG)
        .map((cfg) => cfg.credentialEnv)
        .filter(Boolean),
      "BEDROCK_API_KEY",
      "DISCORD_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
      "TELEGRAM_BOT_TOKEN",
    ]);
    const sandboxEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !blockedSandboxEnvNames.has(name)),
    );
    return { blockedSandboxEnvNames, envArgs, sandboxEnv };
  }

  function buildCreateCommand(createArgs, envArgs) {
    return `${openshellShellCommand([
      "sandbox",
      "create",
      ...createArgs,
      "--",
      "env",
      ...envArgs,
      "nemoclaw-start",
    ])} 2>&1`;
  }

  async function streamSandboxCreation({ createCommand, sandboxEnv, sandboxName }) {
    return streamSandboxCreate(createCommand, sandboxEnv, {
      readyCheck: () => {
        const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
        return isSandboxReady(list, sandboxName);
      },
    });
  }

  function cleanupBuildContext(buildCtx) {
    run(`rm -rf "${buildCtx}"`, { ignoreError: true });
  }

  function handleSandboxCreateFailure(createResult) {
    if (createResult.status === 0) {
      return;
    }
    const failure = classifySandboxCreateFailure(createResult.output);
    if (failure.kind === "sandbox_create_incomplete") {
      console.warn("");
      console.warn(
        `  Create stream exited with code ${createResult.status} after sandbox was created.`,
      );
      console.warn("  Checking whether the sandbox reaches Ready state...");
      return;
    }

    console.error("");
    console.error(`  Sandbox creation failed (exit ${createResult.status}).`);
    if (createResult.output) {
      console.error("");
      console.error(createResult.output);
    }
    console.error("  Try:  openshell sandbox list        # check gateway state");
    printSandboxCreateRecoveryHints(createResult.output);
    process.exit(createResult.status || 1);
  }

  function waitForCreatedSandboxReady(sandboxName) {
    console.log("  Waiting for sandbox to become ready...");
    for (let i = 0; i < 30; i += 1) {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isSandboxReady(list, sandboxName)) {
        return true;
      }
      sleep(2);
    }
    return false;
  }

  function handleSandboxReadyTimeout(sandboxName) {
    const delResult = runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    console.error("");
    console.error(`  Sandbox '${sandboxName}' was created but did not become ready within 60s.`);
    if (delResult.status === 0) {
      console.error("  The orphaned sandbox has been removed — you can safely retry.");
    } else {
      console.error("  Could not remove the orphaned sandbox. Manual cleanup:");
      console.error(`    openshell sandbox delete "${sandboxName}"`);
    }
    console.error("  Retry: nemoclaw onboard");
    process.exit(1);
  }

  function waitForDashboardReadiness(sandboxName) {
    console.log("  Waiting for NemoClaw dashboard to become ready...");
    for (let i = 0; i < 15; i += 1) {
      const readyMatch = runCapture(
        `openshell sandbox exec ${shellQuote(sandboxName)} curl -sf http://localhost:18789/ 2>/dev/null || echo "no"`,
        { ignoreError: true },
      );
      if (readyMatch && !readyMatch.includes("no")) {
        console.log("  ✓ Dashboard is live");
        return;
      }
      if (i === 14) {
        console.warn("  Dashboard taking longer than expected to start. Continuing...");
      } else {
        sleep(2);
      }
    }
  }

  function registerSandboxRuntime({ agent, dangerouslySkipPermissions, gpu, sandboxName }) {
    ensureDashboardForward(
      sandboxName,
      process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
    );
    registry.registerSandbox({
      name: sandboxName,
      gpuEnabled: !!gpu,
      agent: agent ? agent.name : null,
      dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
    });
  }

  function setupSandboxDnsProxy(sandboxName) {
    console.log("  Setting up sandbox DNS proxy...");
    run(
      `bash "${path.join(SCRIPTS, "setup-dns-proxy.sh")}" ${shellQuote(GATEWAY_NAME)} ${shellQuote(sandboxName)} 2>&1 || true`,
      { ignoreError: true },
    );
  }

  function verifyMessagingProviders(messagingProviders) {
    for (const providerName of messagingProviders) {
      if (!providerExistsInGateway(providerName)) {
        console.error(`  ⚠ Messaging provider '${providerName}' was not found in the gateway.`);
        console.error("    The credential may not be available inside the sandbox.");
        console.error(
          `    To fix: openshell provider create --name ${providerName} --type generic --credential <KEY>`,
        );
      }
    }
  }

  function patchSandboxDockerfile({
    activeMessagingChannels,
    chatUiUrl,
    discordGuilds,
    messagingAllowedIds,
    preferredInferenceApi,
    provider,
    stagedDockerfile,
    webSearchConfig,
    model,
  }) {
    patchStagedDockerfile(
      stagedDockerfile,
      model,
      chatUiUrl,
      String(Date.now()),
      provider,
      preferredInferenceApi,
      webSearchConfig,
      activeMessagingChannels,
      messagingAllowedIds,
      discordGuilds,
    );
  }

  async function createSandbox(
    gpu,
    model,
    provider,
    preferredInferenceApi = null,
    sandboxNameOverride = null,
    webSearchConfig = null,
    enabledChannels = null,
    fromDockerfile = null,
    agent = null,
    dangerouslySkipPermissions = false,
  ) {
    step(6, 8, "Creating sandbox");

    const sandboxName = sandboxNameOverride || (await promptValidatedSandboxName());
    const effectivePort = agent ? agent.forwardPort : CONTROL_UI_PORT;
    const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${effectivePort}`;
    const messagingTokenDefs = buildMessagingTokenDefs(sandboxName, enabledChannels);
    const reuseDecision = await maybeReuseExistingSandbox({
      chatUiUrl,
      messagingTokenDefs,
      sandboxName,
    });
    if (reuseDecision.reused) {
      return sandboxName;
    }

    const { buildCtx, stagedDockerfile } = stageSandboxBuildContext({ agent, fromDockerfile });
    const basePolicyPath = resolveBasePolicyPath({ agent, dangerouslySkipPermissions });
    const createArgs = buildSandboxCreateArgs({ basePolicyPath, buildCtx, sandboxName });
    const messagingProviders = upsertMessagingProviders(messagingTokenDefs);
    for (const providerName of messagingProviders) {
      createArgs.push("--provider", providerName);
    }

    console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
    ensureBraveCredentialAvailable(webSearchConfig);
    const activeMessagingChannels = buildActiveMessagingChannels(messagingTokenDefs);
    const messagingAllowedIds = buildMessagingAllowedIds(messagingTokenDefs);
    const discordGuilds = buildDiscordGuilds(messagingTokenDefs);
    patchSandboxDockerfile({
      activeMessagingChannels,
      chatUiUrl,
      discordGuilds,
      messagingAllowedIds,
      preferredInferenceApi,
      provider,
      stagedDockerfile,
      webSearchConfig,
      model,
    });
    const { envArgs, sandboxEnv } = buildSandboxRuntimeEnv(chatUiUrl);
    const createCommand = buildCreateCommand(createArgs, envArgs);
    const createResult = await streamSandboxCreation({ createCommand, sandboxEnv, sandboxName });

    cleanupBuildContext(buildCtx);
    handleSandboxCreateFailure(createResult);

    if (!waitForCreatedSandboxReady(sandboxName)) {
      handleSandboxReadyTimeout(sandboxName);
    }

    waitForDashboardReadiness(sandboxName);
    ensureDashboardForward(sandboxName, chatUiUrl);
    registry.registerSandbox({
      name: sandboxName,
      gpuEnabled: !!gpu,
      agent: agent ? agent.name : null,
      dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
    });
    setupSandboxDnsProxy(sandboxName);
    verifyMessagingProviders(messagingProviders);

    console.log(`  ✓ Sandbox '${sandboxName}' created`);
    return sandboxName;
  }

  return {
    buildSandboxConfigSyncScript,
    createSandbox,
    getSandboxReuseState,
    isOpenclawReady,
    pruneStaleSandboxEntry,
    promptValidatedSandboxName,
    repairRecordedSandbox,
    waitForSandboxReady,
    writeSandboxConfigSyncFile,
  };
}
