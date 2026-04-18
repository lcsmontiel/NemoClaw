// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { runSandboxProvisioningFlow } from "../../dist/lib/onboard-sandbox-flow";

describe("runSandboxProvisioningFlow", () => {
  it("configures messaging and creates a sandbox on a fresh flow", async () => {
    const events: string[] = [];
    const createSandbox = vi.fn(async () => "alpha");

    const result = await runSandboxProvisioningFlow(
      {
        gpu: null,
        sandboxName: null,
        model: "gpt-5.4",
        provider: "openai-api",
        preferredInferenceApi: "responses",
        webSearchConfig: null,
        selectedMessagingChannels: [],
        nimContainer: null,
        fromDockerfile: null,
        agent: null,
        dangerouslySkipPermissions: false,
      },
      {
        resume: false,
        sessionMessagingChannels: null,
        sessionWebSearchConfig: null,
        hasCompletedMessaging: false,
        hasCompletedSandbox: false,
        setupMessagingChannels: async () => ["telegram"],
        configureWebSearch: async () => ({ fetchEnabled: true }),
        ensureValidatedBraveSearchCredential: async () => null,
        getSandboxReuseState: () => "missing",
        removeSandbox: () => events.push("remove-sandbox"),
        repairRecordedSandbox: () => events.push("repair-sandbox"),
        createSandbox,
        persistRegistryModelProvider: (sandboxName, patch) =>
          events.push(`persist:${sandboxName}:${patch.provider}:${patch.model}`),
        onNote: (message) => events.push(`note:${message}`),
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
      },
    );

    expect(result.sandboxName).toBe("alpha");
    expect(result.selectedMessagingChannels).toEqual(["telegram"]);
    expect(result.webSearchConfig).toEqual({ fetchEnabled: true });
    expect(createSandbox).toHaveBeenCalledWith(
      null,
      "gpt-5.4",
      "openai-api",
      "responses",
      null,
      { fetchEnabled: true },
      ["telegram"],
      null,
      null,
      false,
    );
    expect(events).toEqual([
      "start:messaging",
      "complete:messaging",
      "start:sandbox",
      "persist:alpha:openai-api:gpt-5.4",
      "complete:sandbox",
    ]);
  });

  it("reuses a completed sandbox without rerunning messaging or sandbox creation", async () => {
    const events: string[] = [];

    const result = await runSandboxProvisioningFlow(
      {
        gpu: null,
        sandboxName: "alpha",
        model: "gpt-5.4",
        provider: "openai-api",
        preferredInferenceApi: "responses",
        webSearchConfig: { fetchEnabled: true },
        selectedMessagingChannels: ["telegram"],
        nimContainer: null,
        fromDockerfile: null,
        agent: null,
        dangerouslySkipPermissions: false,
      },
      {
        resume: true,
        sessionMessagingChannels: ["telegram"],
        sessionWebSearchConfig: { fetchEnabled: true },
        hasCompletedMessaging: true,
        hasCompletedSandbox: true,
        setupMessagingChannels: async () => {
          throw new Error("should not rerun messaging");
        },
        configureWebSearch: async () => {
          throw new Error("should not rerun web search config");
        },
        ensureValidatedBraveSearchCredential: async () => null,
        getSandboxReuseState: () => "ready",
        removeSandbox: () => events.push("remove-sandbox"),
        repairRecordedSandbox: () => events.push("repair-sandbox"),
        createSandbox: async () => {
          throw new Error("should not recreate sandbox");
        },
        persistRegistryModelProvider: () => events.push("persist"),
        onNote: (message) => events.push(`note:${message}`),
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
      },
    );

    expect(result.sandboxName).toBe("alpha");
    expect(events).toEqual([
      "note:  [resume] Reusing Brave Search configuration already baked into the sandbox.",
      "skip:sandbox:alpha",
    ]);
  });

  it("reuses recorded messaging channels when rebuilding a completed sandbox", async () => {
    const events: string[] = [];
    const createSandbox = vi.fn(async () => "alpha");

    const result = await runSandboxProvisioningFlow(
      {
        gpu: null,
        sandboxName: "alpha",
        model: "gpt-5.4",
        provider: "openai-api",
        preferredInferenceApi: "responses",
        webSearchConfig: { fetchEnabled: true },
        selectedMessagingChannels: [],
        nimContainer: null,
        fromDockerfile: null,
        agent: null,
        dangerouslySkipPermissions: false,
      },
      {
        resume: true,
        sessionMessagingChannels: ["telegram", "slack"],
        sessionWebSearchConfig: { fetchEnabled: true },
        hasCompletedMessaging: true,
        hasCompletedSandbox: true,
        setupMessagingChannels: async () => {
          throw new Error("should not rerun messaging");
        },
        configureWebSearch: async () => null,
        ensureValidatedBraveSearchCredential: async () => "brave-key",
        getSandboxReuseState: () => "not_ready",
        removeSandbox: () => events.push("remove-sandbox"),
        repairRecordedSandbox: (sandboxName) => events.push(`repair:${sandboxName}`),
        createSandbox,
        persistRegistryModelProvider: () => events.push("persist"),
        onNote: (message) => events.push(`note:${message}`),
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
      },
    );

    expect(result.selectedMessagingChannels).toEqual(["telegram", "slack"]);
    expect(result.webSearchConfig).toEqual({ fetchEnabled: true });
    expect(createSandbox).toHaveBeenCalledWith(
      null,
      "gpt-5.4",
      "openai-api",
      "responses",
      "alpha",
      { fetchEnabled: true },
      ["telegram", "slack"],
      null,
      null,
      false,
    );
    expect(events).toEqual([
      "note:  [resume] Recorded sandbox 'alpha' exists but is not ready; recreating it.",
      "repair:alpha",
      "note:  [resume] Revalidating Brave Search configuration for sandbox recreation.",
      "note:  [resume] Reusing Brave Search configuration.",
      "skip:messaging:telegram, slack",
      "start:sandbox",
      "persist",
      "complete:sandbox",
    ]);
  });
});
