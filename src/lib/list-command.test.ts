// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createListCommand,
  runListCommand,
  runRegisteredListCommand,
} from "./list-command";

function makeExit(): (code: number) => never {
  return ((code: number) => {
    throw new Error(`EXIT:${code}`);
  }) as (code: number) => never;
}

function captureConsoleLog(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((message?: string) => {
    chunks.push(message ?? "");
  });

  return {
    chunks,
    restore: () => spy.mockRestore(),
  };
}

describe("list command", () => {
  it("prints oclif help for the standalone list command without loading inventory", async () => {
    const recoverRegistryEntries = vi.fn(async () => ({ sandboxes: [], defaultSandbox: null }));
    const stdout = captureConsoleLog();

    try {
      await runListCommand(["--help"], {
        rootDir: process.cwd(),
        recoverRegistryEntries,
        getLiveInference: () => null,
        loadLastSession: () => null,
        log: vi.fn(),
        error: vi.fn(),
        exit: makeExit(),
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.chunks.join("")).toContain("USAGE");
    expect(stdout.chunks.join("")).toContain("$ nemoclaw list [--json]");
    expect(recoverRegistryEntries).not.toHaveBeenCalled();
  });

  it("renders JSON inventory through oclif's built-in json flag", async () => {
    const lines: string[] = [];

    await runListCommand(["--json"], {
      rootDir: process.cwd(),
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["pypi"],
            agent: "openclaw",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      loadLastSession: () => null,
      getActiveSessionCount: () => 1,
      log: (message = "") => lines.push(message),
      error: vi.fn(),
      exit: makeExit(),
    });

    expect(JSON.parse(lines.join("\n"))).toEqual({
      schemaVersion: 1,
      defaultSandbox: "alpha",
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: null,
      sandboxes: [
        {
          name: "alpha",
          model: "configured-model",
          provider: "configured-provider",
          gpuEnabled: true,
          policies: ["pypi"],
          agent: "openclaw",
          isDefault: true,
          activeSessionCount: 1,
          connected: true,
        },
      ],
    });
  });

  it("creates commands bound to independent dependency sets", async () => {
    const alphaLines: string[] = [];
    const betaLines: string[] = [];

    const AlphaCommand = createListCommand({
      rootDir: process.cwd(),
      recoverRegistryEntries: async () => ({
        sandboxes: [{ name: "alpha" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      loadLastSession: () => null,
      log: (message = "") => alphaLines.push(message),
      error: vi.fn(),
      exit: makeExit(),
    });
    const BetaCommand = createListCommand({
      rootDir: process.cwd(),
      recoverRegistryEntries: async () => ({
        sandboxes: [{ name: "beta" }],
        defaultSandbox: "beta",
      }),
      getLiveInference: () => null,
      loadLastSession: () => null,
      log: (message = "") => betaLines.push(message),
      error: vi.fn(),
      exit: makeExit(),
    });

    await AlphaCommand.run(["--json"], process.cwd());
    await BetaCommand.run(["--json"], process.cwd());

    expect(JSON.parse(alphaLines.join("\n"))).toMatchObject({
      defaultSandbox: "alpha",
      sandboxes: [{ name: "alpha" }],
    });
    expect(JSON.parse(betaLines.join("\n"))).toMatchObject({
      defaultSandbox: "beta",
      sandboxes: [{ name: "beta" }],
    });
  });

  it("runs the registered list command through the explicit oclif map", async () => {
    const stdout = captureConsoleLog();

    try {
      await runRegisteredListCommand(["--help"], {
        rootDir: process.cwd(),
        error: vi.fn(),
        exit: makeExit(),
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.chunks.join("")).toContain("USAGE");
    expect(stdout.chunks.join("")).toContain("$ nemoclaw list [--json]");
  });

  it("forwards oclif parse errors for invalid list flags", async () => {
    const errorLines: string[] = [];

    await expect(
      runListCommand(["--bogus"], {
        rootDir: process.cwd(),
        recoverRegistryEntries: async () => ({ sandboxes: [], defaultSandbox: null }),
        getLiveInference: () => null,
        loadLastSession: () => null,
        log: vi.fn(),
        error: (message = "") => errorLines.push(message),
        exit: makeExit(),
      }),
    ).rejects.toThrow("EXIT:2");

    expect(errorLines).toEqual(["  Nonexistent flag: --bogus\nSee more help with --help"]);
  });
});
