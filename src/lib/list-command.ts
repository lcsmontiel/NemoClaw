// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Config as OclifConfig, type Config, Flags } from "@oclif/core";

import {
  getSandboxInventory,
  type ListSandboxesCommandDeps,
  renderSandboxInventoryText,
} from "./inventory-commands";

export interface RunListCommandDeps extends ListSandboxesCommandDeps {
  rootDir: string;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

function isListParseError(error: unknown): boolean {
  const name =
    error && typeof error === "object"
      ? (error as { constructor?: { name?: string } }).constructor?.name
      : "";
  return name === "NonExistentFlagsError" || name === "UnexpectedArgsError";
}

export interface ListCommandClass {
  new (argv: string[], config: Config): Command;
  run(argv?: string[], opts?: string): Promise<unknown>;
}

function resolveListCommandDeps(
  depsOrProvider: RunListCommandDeps | (() => RunListCommandDeps),
): RunListCommandDeps {
  return typeof depsOrProvider === "function" ? depsOrProvider() : depsOrProvider;
}

export function createListCommand(
  depsOrProvider: RunListCommandDeps | (() => RunListCommandDeps),
): ListCommandClass {
  return class ListCommand extends Command {
    static id = "list";
    static strict = true;
    static enableJsonFlag = true;
    static summary = "List all sandboxes";
    static description =
      "List all registered sandboxes with their model, provider, and policy presets.";
    static usage = ["list [--json]"];
    static flags = {
      help: Flags.help({ char: "h" }),
    };

    protected logJson(json: unknown): void {
      const deps = resolveListCommandDeps(depsOrProvider);
      const log = deps.log ?? console.log;
      log(JSON.stringify(json, null, 2));
    }

    public async run(): Promise<unknown> {
      await this.parse(ListCommand);
      const deps = resolveListCommandDeps(depsOrProvider);
      const log = deps.log ?? console.log;
      const inventory = await getSandboxInventory(deps);
      if (this.jsonEnabled()) {
        return inventory;
      }

      renderSandboxInventoryText(inventory, log);
    }
  };
}

function getOclifExitCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const oclif = (error as { oclif?: { exit?: number } }).oclif;
  return typeof oclif?.exit === "number" ? oclif.exit : null;
}

function formatOclifError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim();
  }

  return String(error).trim();
}

function handleListCommandError(
  error: unknown,
  writer: (message?: string) => void,
  exit: (code: number) => never,
): never | void {
  const exitCode = getOclifExitCode(error);
  if (exitCode === 0) {
    process.exitCode = 0;
    return;
  }

  if (isListParseError(error)) {
    writer(`  ${formatOclifError(error)}`);
    exit(exitCode ?? 1);
  }

  throw error;
}

export async function runListCommand(args: string[], deps: RunListCommandDeps): Promise<void> {
  const ListCommand = createListCommand(deps);
  const errorLine = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  try {
    await ListCommand.run(args, deps.rootDir);
  } catch (error) {
    handleListCommandError(error, errorLine, exit);
  }
}

export async function runRegisteredListCommand(
  args: string[],
  opts: Pick<RunListCommandDeps, "rootDir" | "error" | "exit">,
): Promise<void> {
  const config = await OclifConfig.load(opts.rootDir);
  const errorLine = opts.error ?? console.error;
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  try {
    await config.runCommand("list", args);
  } catch (error) {
    handleListCommandError(error, errorLine, exit);
  }
}
