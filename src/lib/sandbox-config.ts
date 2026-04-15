// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side sandbox configuration inspection.
//
// Reads the sandbox's openclaw.json via `openshell sandbox exec` and
// displays it with credential values redacted. Read-only — config
// mutations are handled by `nemoclaw config set` (Phase 2).

const { runCapture, validateName, shellQuote } = require("./runner");
const { stripCredentials } = require("./credential-filter");

// ---------------------------------------------------------------------------
// Dotpath extraction
// ---------------------------------------------------------------------------

function extractDotpath(obj: unknown, dotpath: string): unknown {
  const keys = dotpath.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// ---------------------------------------------------------------------------
// config get
// ---------------------------------------------------------------------------

function getOpenshellCommand(): string {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN;
  if (!binary) return "openshell";
  return shellQuote(binary);
}

interface ConfigGetOpts {
  key?: string | null;
  format?: string;
}

function configGet(sandboxName: string, opts: ConfigGetOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  const openshell = getOpenshellCommand();
  const cmd = `${openshell} sandbox exec ${shellQuote(sandboxName)} cat /sandbox/.openclaw/openclaw.json 2>/dev/null`;

  let raw: string;
  try {
    raw = runCapture(cmd, { ignoreError: true });
  } catch {
    raw = "";
  }

  if (!raw || !raw.trim()) {
    console.error("  Cannot read sandbox config. Is the sandbox running?");
    process.exit(1);
  }

  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to parse sandbox config: ${message}`);
    process.exit(1);
  }

  // Strip credentials before display
  config = stripCredentials(config);

  // Remove gateway section (contains auth tokens — per migration-state.ts pattern)
  if (config && typeof config === "object" && !Array.isArray(config)) {
    delete (config as Record<string, unknown>).gateway;
  }

  // Extract dotpath if specified
  if (opts.key) {
    const value = extractDotpath(config, opts.key);
    if (value === undefined) {
      console.error(`  Key "${opts.key}" not found in sandbox config.`);
      process.exit(1);
    }
    config = value;
  }

  // Format output
  const format = opts.format || "json";
  if (format === "yaml") {
    // Lazy require — YAML is available in the project
    const YAML = require("yaml");
    console.log(YAML.stringify(config));
  } else {
    console.log(JSON.stringify(config, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { configGet, extractDotpath };
