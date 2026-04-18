// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bootstrapDistPath = require.resolve("../../dist/lib/onboard-bootstrap");
const persistentDriverDistPath = require.resolve("../../dist/lib/onboard-persistent-driver");
const flowStateDistPath = require.resolve("../../dist/lib/onboard-flow-state");
const sessionDistPath = require.resolve("../../dist/lib/onboard-session");
const originalHome = process.env.HOME;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-"));
  process.env.HOME = tmpDir;
  delete require.cache[bootstrapDistPath];
  delete require.cache[persistentDriverDistPath];
  delete require.cache[flowStateDistPath];
  delete require.cache[sessionDistPath];
});

afterEach(() => {
  delete require.cache[bootstrapDistPath];
  delete require.cache[persistentDriverDistPath];
  delete require.cache[flowStateDistPath];
  delete require.cache[sessionDistPath];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("initializeOnboardRun", () => {
  it("creates a fresh session and resolves --from paths", () => {
    const { initializeOnboardRun } = require("../../dist/lib/onboard-bootstrap");

    const result = initializeOnboardRun({
      resume: false,
      mode: "non-interactive",
      requestedFromDockerfile: "./Dockerfile.custom",
      requestedAgent: "hermes",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected fresh onboarding initialization to succeed");
    }
    expect(result.value.session.mode).toBe("non-interactive");
    expect(result.value.session.agent).toBe("hermes");
    expect(result.value.fromDockerfile).toBe(path.resolve("./Dockerfile.custom"));
    expect(result.value.driver.session?.metadata.fromDockerfile).toBe(
      path.resolve("./Dockerfile.custom"),
    );
  });

  it("returns a friendly error when no resumable session exists", () => {
    const { initializeOnboardRun } = require("../../dist/lib/onboard-bootstrap");

    const result = initializeOnboardRun({
      resume: true,
      mode: "interactive",
      requestedFromDockerfile: null,
      requestedAgent: null,
    });

    expect(result).toEqual({
      ok: false,
      lines: ["  No resumable onboarding session was found.", "  Run: nemoclaw onboard"],
    });
  });

  it("reports resume conflicts using the shared formatter", () => {
    const onboardSession = require("../../dist/lib/onboard-session");
    const { initializeOnboardRun } = require("../../dist/lib/onboard-bootstrap");

    onboardSession.saveSession(
      onboardSession.createSession({
        sandboxName: "alpha",
        provider: "nvidia-prod",
        model: "meta/llama-3.3-70b-instruct",
      }),
    );

    const result = initializeOnboardRun({
      resume: true,
      mode: "interactive",
      requestedFromDockerfile: null,
      requestedAgent: null,
      getResumeConflicts: (session: { sandboxName: string | null; provider: string | null }) => [
        { field: "sandbox", requested: "beta", recorded: session.sandboxName },
        { field: "provider", requested: "openai-api", recorded: session.provider },
      ],
    });

    expect(result).toEqual({
      ok: false,
      lines: [
        "  Resumable state belongs to sandbox 'alpha', not 'beta'.",
        "  Resumable state recorded provider 'nvidia-prod', not 'openai-api'.",
        "  Run: nemoclaw onboard              # start a fresh onboarding session",
        "  Or rerun with the original settings to continue that session.",
      ],
    });
  });

  it("loads a resumable session, reuses the recorded Dockerfile, and clears failure state", () => {
    const onboardSession = require("../../dist/lib/onboard-session");
    const { initializeOnboardRun } = require("../../dist/lib/onboard-bootstrap");

    onboardSession.saveSession(
      onboardSession.createSession({
        mode: "interactive",
        status: "failed",
        sandboxName: "alpha",
        metadata: { gatewayName: "nemoclaw", fromDockerfile: "/tmp/Recorded.Dockerfile" },
        failure: {
          step: "policies",
          message: "policy apply failed",
          recordedAt: "2026-04-17T00:00:00.000Z",
        },
      }),
    );

    const result = initializeOnboardRun({
      resume: true,
      mode: "non-interactive",
      requestedFromDockerfile: null,
      requestedAgent: null,
      getResumeConflicts: () => [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected resume initialization to succeed");
    }
    expect(result.value.fromDockerfile).toBe("/tmp/Recorded.Dockerfile");
    expect(result.value.session.mode).toBe("non-interactive");
    expect(result.value.session.status).toBe("in_progress");
    expect(result.value.session.failure).toBeNull();
  });
});
