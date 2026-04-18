// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  getDashboardProviderLabel,
  printOnboardDashboard,
} from "../../dist/lib/onboard-dashboard-print";

describe("onboard-dashboard-print", () => {
  it("maps known provider ids to user-facing labels", () => {
    expect(getDashboardProviderLabel("nvidia-prod")).toBe("NVIDIA Endpoints");
    expect(getDashboardProviderLabel("openai-api")).toBe("OpenAI");
    expect(getDashboardProviderLabel("anthropic-prod")).toBe("Anthropic");
    expect(getDashboardProviderLabel("gemini-api")).toBe("Google Gemini");
    expect(getDashboardProviderLabel("custom-provider")).toBe("custom-provider");
  });

  it("prints the tokenized OpenClaw dashboard when a token is available", () => {
    const lines: string[] = [];
    printOnboardDashboard("alpha", "gpt-5.4", "openai-api", null, null, {
      getNimStatus: () => ({ running: false }),
      fetchGatewayAuthTokenFromSandbox: () => "secret-token",
      getDashboardAccessInfo: () => [
        { label: "Dashboard", url: "http://127.0.0.1:18789/#token=secret-token" },
      ],
      getDashboardGuidanceLines: () => ["Port 18789 must be forwarded before opening these URLs."],
      note: (message) => lines.push(`note:${message}`),
      log: (message = "") => lines.push(message),
      printAgentDashboardUi: () => {
        throw new Error("should not enter agent dashboard path");
      },
      buildControlUiUrls: () => [],
      getWslHostAddress: () => null,
      buildAuthenticatedDashboardUrl: (baseUrl, token) => `${baseUrl}#token=${token}`,
    });

    expect(lines).toContain("  OpenClaw UI (tokenized URL; treat it like a password)");
    expect(lines).toContain("  Dashboard: http://127.0.0.1:18789/#token=secret-token");
    expect(lines).not.toContainEqual(expect.stringMatching(/^note:/));
  });

  it("prints agent dashboard UI and appends a WSL URL when needed", () => {
    const lines: string[] = [];
    const printAgentDashboardUi = vi.fn();
    printOnboardDashboard(
      "alpha",
      "meta/llama-3.3-70b-instruct",
      "nvidia-prod",
      "nim-123",
      { name: "hermes" },
      {
        getNimStatus: () => ({ running: true }),
        fetchGatewayAuthTokenFromSandbox: () => "secret-token",
        getDashboardAccessInfo: () => [],
        getDashboardGuidanceLines: () => [],
        note: (message) => lines.push(`note:${message}`),
        log: (message = "") => lines.push(message),
        printAgentDashboardUi,
        buildControlUiUrls: (token, port) => [`http://127.0.0.1:${port}/#token=${token}`],
        getWslHostAddress: () => "172.24.240.1",
        buildAuthenticatedDashboardUrl: (baseUrl, token) => `${baseUrl}#token=${token}`,
      },
    );

    expect(printAgentDashboardUi).toHaveBeenCalledTimes(1);
    const buildUrls = printAgentDashboardUi.mock.calls[0][3].buildControlUiUrls;
    expect(buildUrls("secret-token", 19999)).toEqual([
      "http://127.0.0.1:19999/#token=secret-token",
      "http://172.24.240.1:19999/#token=secret-token",
    ]);
  });

  it("prints fallback token guidance when the token cannot be fetched", () => {
    const lines: string[] = [];
    printOnboardDashboard("alpha", "gpt-5.4", "openai-api", null, null, {
      getNimStatus: () => ({ running: false }),
      fetchGatewayAuthTokenFromSandbox: () => null,
      getDashboardAccessInfo: () => [{ label: "Dashboard", url: "http://127.0.0.1:18789/" }],
      getDashboardGuidanceLines: () => ["No dashboard URLs were generated."],
      note: (message) => lines.push(`note:${message}`),
      log: (message = "") => lines.push(message),
      printAgentDashboardUi: () => {
        throw new Error("should not enter agent dashboard path");
      },
      buildControlUiUrls: () => [],
      getWslHostAddress: () => null,
      buildAuthenticatedDashboardUrl: (baseUrl, token) => `${baseUrl}#token=${token}`,
    });

    expect(lines).toContain("  OpenClaw UI");
    expect(lines).toContain(
      "  Token:       nemoclaw alpha connect  →  jq -r '.gateway.auth.token' /sandbox/.openclaw/openclaw.json",
    );
    expect(lines).toContain("note:  Could not read gateway token from the sandbox (download failed).");
  });
});
