// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  getSuggestedPolicyPresets,
  LOCAL_INFERENCE_PROVIDERS,
} from "../../dist/lib/onboard-policy-suggestions";

describe("onboard-policy-suggestions", () => {
  it("exports the local inference providers used for policy suggestions", () => {
    expect(LOCAL_INFERENCE_PROVIDERS).toEqual(["ollama-local", "vllm-local"]);
  });

  it("suggests baseline, messaging, brave, and local-inference presets as expected", () => {
    expect(
      getSuggestedPolicyPresets({
        enabledChannels: ["telegram"],
        webSearchConfig: { fetchEnabled: true },
        provider: "ollama-local",
        getCredential: () => null,
        env: {},
      }),
    ).toEqual(["pypi", "npm", "local-inference", "telegram", "brave"]);
  });

  it("auto-detects messaging presets from credentials/env in interactive tty mode", () => {
    const notes: string[] = [];
    const getCredential = vi.fn((envKey: string) =>
      envKey === "SLACK_BOT_TOKEN" ? "xoxb-token" : null,
    );
    const result = getSuggestedPolicyPresets({
      provider: "nvidia-prod",
      getCredential,
      env: { DISCORD_BOT_TOKEN: "discord-token", CI: "false" } as NodeJS.ProcessEnv,
      isInteractiveTty: true,
      isNonInteractive: false,
      note: (message) => notes.push(message),
    });

    expect(result).toEqual(["pypi", "npm", "slack", "discord"]);
    expect(notes).toEqual([
      "  Auto-detected: SLACK_BOT_TOKEN -> suggesting slack preset",
      "  Auto-detected: DISCORD_BOT_TOKEN -> suggesting discord preset",
    ]);
  });
});
