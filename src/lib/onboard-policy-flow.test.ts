// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runPolicySetupFlow } from "./onboard-policy-flow";

describe("runPolicySetupFlow", () => {
  it("applies the permissive policy after the sandbox is ready", async () => {
    const events: string[] = [];

    const result = await runPolicySetupFlow(
      {
        sandboxName: "alpha",
        provider: "openai-api",
        model: "gpt-5.4",
        webSearchConfig: null,
        enabledChannels: [],
        recordedPolicyPresets: null,
      },
      {
        resume: false,
        dangerouslySkipPermissions: true,
        hasCompletedPolicies: false,
        waitForSandboxReady: () => true,
        applyPermissivePolicy: (sandboxName) => events.push(`apply:${sandboxName}`),
        arePolicyPresetsApplied: () => false,
        setupPoliciesWithSelection: async () => {
          throw new Error("should not configure presets when using permissive mode");
        },
        onShowHeader: () => events.push("show-header"),
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
        onSelectionPersist: (policyPresets) => events.push(`persist:${policyPresets.join(",")}`),
      },
    );

    expect(result).toEqual({ kind: "complete", policyPresets: [] });
    expect(events).toEqual(["show-header", "apply:alpha", "complete:policies"]);
  });

  it("returns a not-ready error in permissive mode without applying policy", async () => {
    const events: string[] = [];

    const result = await runPolicySetupFlow(
      {
        sandboxName: "alpha",
        provider: "openai-api",
        model: "gpt-5.4",
        webSearchConfig: null,
        enabledChannels: [],
        recordedPolicyPresets: null,
      },
      {
        resume: false,
        dangerouslySkipPermissions: true,
        hasCompletedPolicies: false,
        waitForSandboxReady: () => false,
        applyPermissivePolicy: () => events.push("apply"),
        arePolicyPresetsApplied: () => false,
        setupPoliciesWithSelection: async () => {
          throw new Error("should not configure presets when sandbox is not ready");
        },
        onShowHeader: () => events.push("show-header"),
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
        onSelectionPersist: () => events.push("persist"),
      },
    );

    expect(result).toEqual({
      kind: "sandbox_not_ready",
      message: "  ✗ Sandbox 'alpha' not ready after creation. Giving up.",
    });
    expect(events).toEqual(["show-header"]);
  });

  it("skips policies on resume when the selected presets are already applied", async () => {
    const events: string[] = [];

    const result = await runPolicySetupFlow(
      {
        sandboxName: "alpha",
        provider: "openai-api",
        model: "gpt-5.4",
        webSearchConfig: null,
        enabledChannels: ["telegram"],
        recordedPolicyPresets: ["npm", "telegram"],
      },
      {
        resume: true,
        dangerouslySkipPermissions: false,
        hasCompletedPolicies: true,
        waitForSandboxReady: () => true,
        applyPermissivePolicy: () => events.push("apply"),
        arePolicyPresetsApplied: () => true,
        setupPoliciesWithSelection: async () => {
          throw new Error("should not rerun policy selection");
        },
        onShowHeader: () => events.push("show-header"),
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
        onSelectionPersist: () => events.push("persist"),
      },
    );

    expect(result).toEqual({ kind: "complete", policyPresets: ["npm", "telegram"] });
    expect(events).toEqual(["skip:policies:npm, telegram", "complete:policies"]);
  });

  it("runs policy selection and persists operator choices when policies must be configured", async () => {
    const events: string[] = [];
    const setupPoliciesWithSelection = vi.fn(async (_sandboxName, options) => {
      options.onSelection(["npm", "pypi"]);
      return ["npm", "pypi"];
    });

    const result = await runPolicySetupFlow(
      {
        sandboxName: "alpha",
        provider: "openai-api",
        model: "gpt-5.4",
        webSearchConfig: { fetchEnabled: true },
        enabledChannels: ["telegram"],
        recordedPolicyPresets: ["npm"],
      },
      {
        resume: true,
        dangerouslySkipPermissions: false,
        hasCompletedPolicies: false,
        waitForSandboxReady: () => true,
        applyPermissivePolicy: () => events.push("apply"),
        arePolicyPresetsApplied: () => false,
        setupPoliciesWithSelection,
        onShowHeader: () => events.push("show-header"),
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
        onSelectionPersist: (policyPresets) => events.push(`persist:${policyPresets.join(",")}`),
      },
    );

    expect(result).toEqual({ kind: "complete", policyPresets: ["npm", "pypi"] });
    expect(setupPoliciesWithSelection).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        selectedPresets: ["npm"],
        enabledChannels: ["telegram"],
        webSearchConfig: { fetchEnabled: true },
        provider: "openai-api",
      }),
    );
    expect(events).toEqual(["start:policies", "persist:npm,pypi", "complete:policies"]);
  });
});
