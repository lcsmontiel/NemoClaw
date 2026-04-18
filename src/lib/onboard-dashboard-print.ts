// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DashboardAccessInfo } from "./onboard-dashboard";

export function getDashboardProviderLabel(provider: string): string {
  if (provider === "nvidia-prod" || provider === "nvidia-nim") return "NVIDIA Endpoints";
  if (provider === "openai-api") return "OpenAI";
  if (provider === "anthropic-prod") return "Anthropic";
  if (provider === "compatible-anthropic-endpoint") {
    return "Other Anthropic-compatible endpoint";
  }
  if (provider === "gemini-api") return "Google Gemini";
  if (provider === "compatible-endpoint") return "Other OpenAI-compatible endpoint";
  if (provider === "vllm-local") return "Local vLLM";
  if (provider === "ollama-local") return "Local Ollama";
  return provider;
}

export interface PrintOnboardDashboardDeps<TAgent = unknown> {
  getNimStatus: (sandboxName: string, nimContainer: string | null) => { running: boolean };
  fetchGatewayAuthTokenFromSandbox: (sandboxName: string) => string | null;
  getDashboardAccessInfo: (
    sandboxName: string,
    options: { token: string | null },
  ) => DashboardAccessInfo[];
  getDashboardGuidanceLines: (dashboardAccess: DashboardAccessInfo[]) => string[];
  note: (message: string) => void;
  log: (message?: string) => void;
  printAgentDashboardUi: (
    sandboxName: string,
    token: string | null,
    agent: TAgent,
    deps: {
      note: (message: string) => void;
      buildControlUiUrls: (token: string | null, port: number) => string[];
    },
  ) => void;
  buildControlUiUrls: (token: string | null, port: number) => string[];
  getWslHostAddress: () => string | null;
  buildAuthenticatedDashboardUrl: (baseUrl: string, token: string | null) => string;
}

export function printOnboardDashboard<TAgent = unknown>(
  sandboxName: string,
  model: string,
  provider: string,
  nimContainer: string | null,
  agent: TAgent | null,
  deps: PrintOnboardDashboardDeps<TAgent>,
): void {
  const nimStat = deps.getNimStatus(sandboxName, nimContainer);
  const nimLabel = nimStat.running ? "running" : "not running";
  const providerLabel = getDashboardProviderLabel(provider);
  const token = deps.fetchGatewayAuthTokenFromSandbox(sandboxName);
  const dashboardAccess = deps.getDashboardAccessInfo(sandboxName, { token });
  const guidanceLines = deps.getDashboardGuidanceLines(dashboardAccess);

  deps.log("");
  deps.log(`  ${"─".repeat(50)}`);
  deps.log(`  Sandbox      ${sandboxName} (Landlock + seccomp + netns)`);
  deps.log(`  Model        ${model} (${providerLabel})`);
  deps.log(`  NIM          ${nimLabel}`);
  deps.log(`  ${"─".repeat(50)}`);
  deps.log(`  Run:         nemoclaw ${sandboxName} connect`);
  deps.log(`  Status:      nemoclaw ${sandboxName} status`);
  deps.log(`  Logs:        nemoclaw ${sandboxName} logs --follow`);
  deps.log("");

  if (agent) {
    deps.printAgentDashboardUi(sandboxName, token, agent, {
      note: deps.note,
      buildControlUiUrls: (tokenValue, port) => {
        const urls = deps.buildControlUiUrls(tokenValue, port);
        const wslHostAddress = deps.getWslHostAddress();
        if (wslHostAddress) {
          const wslUrl = deps.buildAuthenticatedDashboardUrl(
            `http://${wslHostAddress}:${port}/`,
            tokenValue,
          );
          if (!urls.includes(wslUrl)) {
            urls.push(wslUrl);
          }
        }
        return urls;
      },
    });
  } else if (token) {
    deps.log("  OpenClaw UI (tokenized URL; treat it like a password)");
    for (const line of guidanceLines) {
      deps.log(`  ${line}`);
    }
    for (const entry of dashboardAccess) {
      deps.log(`  ${entry.label}: ${entry.url}`);
    }
  } else {
    deps.note("  Could not read gateway token from the sandbox (download failed).");
    deps.log("  OpenClaw UI");
    for (const line of guidanceLines) {
      deps.log(`  ${line}`);
    }
    for (const entry of dashboardAccess) {
      deps.log(`  ${entry.label}: ${entry.url}`);
    }
    deps.log(
      `  Token:       nemoclaw ${sandboxName} connect  →  jq -r '.gateway.auth.token' /sandbox/.openclaw/openclaw.json`,
    );
    deps.log(
      "               append  #token=<token>  to the URL, or see /tmp/gateway.log inside the sandbox.",
    );
  }
  deps.log(`  ${"─".repeat(50)}`);
  deps.log("");
}
