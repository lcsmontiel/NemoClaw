// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export interface OpenclawSetupDeps {
  step: (current: number, total: number, message: string) => void;
  getProviderSelectionConfig: (provider: string, model: string) => Record<string, unknown> | null;
  writeSandboxConfigSyncFile: (script: string) => string;
  openshellShellCommand: (args: string[], options?: { openshellBinary?: string }) => string;
  shellQuote: (value: string) => string;
  run: (
    command: string | string[],
    options?: { stdio?: [string, string, string] },
  ) => unknown;
  cleanupTempDir: (filePath: string, expectedPrefix: string) => void;
  fetchGatewayAuthTokenFromSandbox: (sandboxName: string) => string | null;
  log: (message: string) => void;
  secureTempFile: (prefix: string, ext?: string) => string;
}

export function buildSandboxConfigSyncScript(selectionConfig: Record<string, unknown>): string {
  // openclaw.json is immutable (root:root 444, Landlock read-only) — never
  // write to it at runtime.  Model routing is handled by the host-side
  // gateway (`openshell inference set` in Step 5), not from inside the
  // sandbox.  We only write the NemoClaw selection config (~/.nemoclaw/).
  return `
set -euo pipefail
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
exit
`.trim();
}

export function isOpenclawReady(sandboxName: string, deps: Pick<OpenclawSetupDeps, "fetchGatewayAuthTokenFromSandbox">): boolean {
  return Boolean(deps.fetchGatewayAuthTokenFromSandbox(sandboxName));
}

export function writeSandboxConfigSyncFile(
  script: string,
  deps: Pick<OpenclawSetupDeps, "secureTempFile">,
): string {
  const scriptFile = deps.secureTempFile("nemoclaw-sync", ".sh");
  fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o600 });
  return scriptFile;
}

export function setupOpenclaw(
  sandboxName: string,
  model: string,
  provider: string,
  deps: OpenclawSetupDeps,
): void {
  deps.step(7, 8, "Setting up OpenClaw inside sandbox");

  const selectionConfig = deps.getProviderSelectionConfig(provider, model);
  if (selectionConfig) {
    const sandboxConfig = {
      ...selectionConfig,
      onboardedAt: new Date().toISOString(),
    };
    const script = buildSandboxConfigSyncScript(sandboxConfig);
    const scriptFile = deps.writeSandboxConfigSyncFile(script);
    try {
      deps.run(
        `${deps.openshellShellCommand(["sandbox", "connect", sandboxName])} < ${deps.shellQuote(scriptFile)}`,
        { stdio: ["ignore", "ignore", "inherit"] },
      );
    } finally {
      deps.cleanupTempDir(scriptFile, "nemoclaw-sync");
    }
  }

  deps.log("  ✓ OpenClaw gateway launched inside sandbox");
}
