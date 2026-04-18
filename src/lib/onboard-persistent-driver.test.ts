// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const driverDistPath = require.resolve("../../dist/lib/onboard-persistent-driver");
const sessionDistPath = require.resolve("../../dist/lib/onboard-session");
const originalHome = process.env.HOME;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-persistent-driver-"));
  process.env.HOME = tmpDir;
  delete require.cache[driverDistPath];
  delete require.cache[sessionDistPath];
});

afterEach(() => {
  delete require.cache[driverDistPath];
  delete require.cache[sessionDistPath];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("PersistentOnboardDriver", () => {
  it("tracks persisted step progress and canonical completion checks", () => {
    const onboardSession = require("../../dist/lib/onboard-session");
    const { PersistentOnboardDriver } = require("../../dist/lib/onboard-persistent-driver");

    onboardSession.saveSession(onboardSession.createSession({ sandboxName: "alpha" }));
    const driver = new PersistentOnboardDriver({ resume: true, requestedSandboxName: "alpha" });

    expect(driver.flowState.phase).toBe("preflight");
    expect(driver.hasCompleted("preflight")).toBe(false);

    driver.startStep("preflight", { sandboxName: "alpha" });
    driver.completeStep("preflight");
    expect(driver.hasCompleted("preflight")).toBe(true);
    expect(driver.flowState.phase).toBe("gateway");

    driver.completeStep("gateway");
    expect(driver.hasCompleted("gateway")).toBe(true);
    expect(driver.flowState.phase).toBe("provider_selection");
  });

  it("persists messaging and runtime aliases through the shared reducers", () => {
    const onboardSession = require("../../dist/lib/onboard-session");
    const { PersistentOnboardDriver } = require("../../dist/lib/onboard-persistent-driver");

    onboardSession.saveSession(
      onboardSession.createSession({
        sandboxName: "alpha",
        provider: "openai-api",
        model: "gpt-5.4",
      }),
    );
    const driver = new PersistentOnboardDriver({ resume: true, requestedSandboxName: "alpha" });

    driver.completeStep("messaging", { messagingChannels: ["telegram"] });
    driver.completeStep("sandbox", { sandboxName: "alpha" });
    driver.completeStep("openclaw", {
      sandboxName: "alpha",
      provider: "openai-api",
      model: "gpt-5.4",
    });

    const session = driver.requiredSession;
    expect(session.messagingChannels).toEqual(["telegram"]);
    expect(session.steps.runtime_setup.status).toBe("complete");
    expect(session.steps.openclaw.status).toBe("complete");
    expect(session.steps.agent_setup.status).toBe("skipped");
    expect(driver.hasCompleted("runtime_setup")).toBe(true);
  });

  it("records failures and final completion using persisted state", () => {
    const onboardSession = require("../../dist/lib/onboard-session");
    const { PersistentOnboardDriver } = require("../../dist/lib/onboard-persistent-driver");

    onboardSession.saveSession(onboardSession.createSession({ sandboxName: "alpha" }));
    const driver = new PersistentOnboardDriver({ resume: true, requestedSandboxName: "alpha" });

    driver.startStep("sandbox", { sandboxName: "alpha" });
    driver.failStep("sandbox", "sandbox create failed");
    expect(driver.flowState.phase).toBe("failed");

    driver.completeStep("sandbox", { sandboxName: "alpha" });
    driver.completeStep("openclaw", { sandboxName: "alpha" });
    driver.completeStep("policies", { sandboxName: "alpha", policyPresets: ["npm"] });
    driver.completeSession({ sandboxName: "alpha", policyPresets: ["npm"] });

    const session = driver.requiredSession;
    expect(session.status).toBe("complete");
    expect(session.resumable).toBe(false);
    expect(session.policyPresets).toEqual(["npm"]);
  });
});
