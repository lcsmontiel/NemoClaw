// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runRuntimeSetupFlow } from "./onboard-runtime-flow";

describe("runRuntimeSetupFlow", () => {
  it("delegates agent setup and skips the openclaw sibling step", async () => {
    const events: string[] = [];
    const handleAgentSetup = vi.fn(async () => {
      events.push("agent-setup");
    });

    await runRuntimeSetupFlow(
      {
        sandboxName: "alpha",
        model: "meta/llama-3.3-70b-instruct",
        provider: "nvidia-prod",
        agent: { name: "hermes" },
        resume: true,
        session: { id: "resume-session" },
      },
      {
        hasCompletedRuntimeSetup: true,
        handleAgentSetup,
        isOpenclawReady: () => false,
        setupOpenclaw: async () => {
          throw new Error("should not run openclaw setup for agent flow");
        },
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
        onSkipSiblingStep: (step) => events.push(`skip-sibling:${step}`),
      },
    );

    expect(handleAgentSetup).toHaveBeenCalledWith(
      "alpha",
      "meta/llama-3.3-70b-instruct",
      "nvidia-prod",
      { name: "hermes" },
      true,
      { id: "resume-session" },
    );
    expect(events).toEqual(["agent-setup", "skip-sibling:openclaw"]);
  });

  it("skips OpenClaw setup when runtime is already complete and ready", async () => {
    const events: string[] = [];

    await runRuntimeSetupFlow(
      {
        sandboxName: "alpha",
        model: "gpt-5.4",
        provider: "openai-api",
        agent: null,
        resume: true,
        session: null,
      },
      {
        hasCompletedRuntimeSetup: true,
        handleAgentSetup: async () => {
          throw new Error("should not enter agent path");
        },
        isOpenclawReady: () => true,
        setupOpenclaw: async () => {
          throw new Error("should not rerun openclaw setup");
        },
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
        onSkipSiblingStep: (step) => events.push(`skip-sibling:${step}`),
      },
    );

    expect(events).toEqual(["skip:openclaw:alpha", "complete:openclaw", "skip-sibling:agent_setup"]);
  });

  it("runs OpenClaw setup when runtime has not been completed", async () => {
    const events: string[] = [];
    const setupOpenclaw = vi.fn(async () => {
      events.push("setup-openclaw");
    });

    await runRuntimeSetupFlow(
      {
        sandboxName: "alpha",
        model: "gpt-5.4",
        provider: "openai-api",
        agent: null,
        resume: false,
        session: null,
      },
      {
        hasCompletedRuntimeSetup: false,
        handleAgentSetup: async () => {
          throw new Error("should not enter agent path");
        },
        isOpenclawReady: () => false,
        setupOpenclaw,
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
        onSkipSiblingStep: (step) => events.push(`skip-sibling:${step}`),
      },
    );

    expect(setupOpenclaw).toHaveBeenCalledWith("alpha", "gpt-5.4", "openai-api");
    expect(events).toEqual(["start:openclaw", "setup-openclaw", "complete:openclaw", "skip-sibling:agent_setup"]);
  });
});
