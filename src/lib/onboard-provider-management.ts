// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

export interface ProviderManagementDeps {
  runOpenshell: (
    args: string[],
    opts?: {
      ignoreError?: boolean;
      env?: Record<string, string>;
      stdio?: [string, string, string];
    },
  ) => { status: number; stdout?: string; stderr?: string };
  compactText: (value: string) => string;
  redact: (value: string) => string;
  registry: {
    getSandbox: (sandboxName: string) => any;
  };
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
}

/**
 * Build the argument array for an `openshell provider create` or `update` command.
 */
export function buildProviderArgs(
  action: "create" | "update",
  name: string,
  type: string,
  credentialEnv: string,
  baseUrl: string | null,
): string[] {
  const args =
    action === "create"
      ? ["provider", "create", "--name", name, "--type", type, "--credential", credentialEnv]
      : ["provider", "update", name, "--credential", credentialEnv];
  if (baseUrl && type === "openai") {
    args.push("--config", `OPENAI_BASE_URL=${baseUrl}`);
  } else if (baseUrl && type === "anthropic") {
    args.push("--config", `ANTHROPIC_BASE_URL=${baseUrl}`);
  }
  return args;
}

/**
 * Check whether an OpenShell provider exists in the gateway.
 */
export function providerExistsInGateway(name: string, deps: ProviderManagementDeps): boolean {
  const result = deps.runOpenshell(["provider", "get", name], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

/**
 * Create or update an OpenShell provider in the gateway.
 */
export function upsertProvider(
  name: string,
  type: string,
  credentialEnv: string,
  baseUrl: string | null,
  env: Record<string, string> = {},
  deps: ProviderManagementDeps,
): { ok: boolean; status?: number; message?: string } {
  const exists = providerExistsInGateway(name, deps);
  const action = exists ? "update" : "create";
  const args = buildProviderArgs(action, name, type, credentialEnv, baseUrl);
  const runOpts = { ignoreError: true, env, stdio: ["ignore", "pipe", "pipe"] as [string, string, string] };
  const result = deps.runOpenshell(args, runOpts);
  if (result.status !== 0) {
    const output =
      deps.compactText(deps.redact(`${result.stderr || ""}`)) ||
      deps.compactText(deps.redact(`${result.stdout || ""}`)) ||
      `Failed to ${action} provider '${name}'.`;
    return { ok: false, status: result.status || 1, message: output };
  }
  return { ok: true };
}

/**
 * Upsert all messaging providers that have tokens configured.
 */
export function upsertMessagingProviders(
  tokenDefs: Array<{ name: string; envKey: string; token: string | null }>,
  deps: ProviderManagementDeps,
): string[] {
  const providers: string[] = [];
  for (const { name, envKey, token } of tokenDefs) {
    if (!token) continue;
    const result = upsertProvider(name, "generic", envKey, null, { [envKey]: token }, deps);
    if (!result.ok) {
      console.error(`\n  ✗ Failed to create messaging provider '${name}': ${result.message}`);
      process.exit(1);
    }
    providers.push(name);
  }
  return providers;
}

/**
 * Compute a SHA-256 hash of a credential value for change detection.
 */
export function hashCredential(value: string | null | undefined): string | null {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value).trim()).digest("hex");
}

/**
 * Detect whether any messaging provider credential has been rotated since
 * the sandbox was created.
 */
export function detectMessagingCredentialRotation(
  sandboxName: string,
  tokenDefs: Array<{ name: string; envKey: string; token: string | null }>,
  deps: ProviderManagementDeps,
): { changed: boolean; changedProviders: string[] } {
  const sandboxEntry = deps.registry.getSandbox(sandboxName);
  const storedHashes = sandboxEntry?.providerCredentialHashes || {};
  const changedProviders: string[] = [];
  for (const { name, envKey, token } of tokenDefs) {
    if (!token) continue;
    const storedHash = storedHashes[envKey];
    if (!storedHash) continue;
    if (storedHash !== hashCredential(token)) {
      changedProviders.push(name);
    }
  }
  return { changed: changedProviders.length > 0, changedProviders };
}

// Tri-state probe factory for messaging-conflict backfill. An upfront liveness
// check is necessary because `openshell provider get` exits non-zero for both
// "provider not attached" and "gateway unreachable"; without the liveness
// gate, a transient gateway failure would be recorded as "no providers" and
// permanently suppress future backfill retries.
export function makeConflictProbe(deps: ProviderManagementDeps): {
  providerExists: (name: string) => "present" | "absent" | "error";
} {
  let gatewayAlive: boolean | null = null;
  const isGatewayAlive = () => {
    if (gatewayAlive === null) {
      const result = deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      // runCaptureOpenshell returns stdout/stderr as a single string; treat
      // any non-empty output as a sign openshell answered. Empty output with
      // ignoreError typically means the binary failed to produce anything.
      gatewayAlive = typeof result === "string" && result.length > 0;
    }
    return gatewayAlive;
  };
  return {
    providerExists: (name: string) => {
      if (!isGatewayAlive()) return "error";
      return providerExistsInGateway(name, deps) ? "present" : "absent";
    },
  };
}
