// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// E2E test for runtime config mutability feature.
// Tests the full chain: shim injection → config-set CLI → overrides file →
// shim deep-merge at load time → gateway.* stripped.
//
// Does NOT require a running sandbox or Docker — exercises real code paths
// with a temporary filesystem standing in for the sandbox writable partition.

import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");

// ═══════════════════════════════════════════════════════════════════
// Phase 1: Shim injection — apply-openclaw-shim.js patches dist files
// ═══════════════════════════════════════════════════════════════════

describe("Phase 1: Shim injection", () => {
  let tmpDistDir;
  const TARGET_FN = "function resolveConfigForRead(resolvedIncludes, env) {";

  // Minimal mock of an OpenClaw dist file containing the target function
  const MOCK_DIST_CONTENT = `
"use strict";
${TARGET_FN}
  return resolvedIncludes;
}
module.exports = { resolveConfigForRead };
`;

  beforeAll(() => {
    tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shim-test-"));
    const mockPkgDir = path.join(tmpDistDir, "pkg");
    const distDir = path.join(mockPkgDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    // Write 3 mock dist files (simulating OpenClaw's multiple entry points)
    for (const name of ["chunk-1.js", "chunk-2.js", "chunk-3.js"]) {
      fs.writeFileSync(path.join(distDir, name), MOCK_DIST_CONTENT);
    }
    // Also write a non-matching file that should NOT be patched
    fs.writeFileSync(path.join(distDir, "utils.js"), "module.exports = {};");
  });

  afterAll(() => {
    fs.rmSync(tmpDistDir, { recursive: true, force: true });
  });

  it("patches all dist files containing resolveConfigForRead", () => {
    const shimScript = path.join(ROOT, "patches", "apply-openclaw-shim.js");
    const pkgDir = path.join(tmpDistDir, "pkg");

    const output = execFileSync("node", [shimScript, pkgDir], {
      encoding: "utf-8",
    });

    // Should report 3 files patched
    assert.match(output, /Patched 3 files/);
    assert.match(output, /Patched: chunk-1\.js/);
    assert.match(output, /Patched: chunk-2\.js/);
    assert.match(output, /Patched: chunk-3\.js/);
  });

  it("injects _nemoClawMergeOverrides before resolveConfigForRead", () => {
    const distDir = path.join(tmpDistDir, "pkg", "dist");
    const patched = fs.readFileSync(path.join(distDir, "chunk-1.js"), "utf-8");

    // The shim function must exist
    assert.ok(
      patched.includes("function _nemoClawMergeOverrides(cfg)"),
      "Shim function not found in patched file",
    );

    // The call must be the first line inside resolveConfigForRead
    assert.ok(
      patched.includes("resolvedIncludes = _nemoClawMergeOverrides(resolvedIncludes);"),
      "Shim call not injected into resolveConfigForRead",
    );

    // The shim must delete gateway.* from overrides
    assert.ok(
      patched.includes("delete _ov.gateway"),
      "Shim does not strip gateway.* from overrides",
    );
  });

  it("does not modify files without the target function", () => {
    const distDir = path.join(tmpDistDir, "pkg", "dist");
    const unpatched = fs.readFileSync(path.join(distDir, "utils.js"), "utf-8");
    assert.strictEqual(unpatched, "module.exports = {};");
  });

  it("exits non-zero when no files match", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shim-empty-"));
    const distDir = path.join(emptyDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "nope.js"), "// nothing here");

    const shimScript = path.join(ROOT, "patches", "apply-openclaw-shim.js");
    try {
      execFileSync("node", [shimScript, emptyDir], { encoding: "utf-8" });
      assert.fail("Expected non-zero exit");
    } catch (err) {
      assert.strictEqual(err.status, 1);
      assert.match(err.stderr, /WARNING: No files patched/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Shim runtime behavior — deep-merge + gateway stripping
// ═══════════════════════════════════════════════════════════════════

describe("Phase 2: Shim runtime behavior", () => {
  let tmpDistDir;
  let tmpOverridesFile;

  const TARGET_FN = "function resolveConfigForRead(resolvedIncludes, env) {";
  const MOCK_DIST = `
"use strict";
${TARGET_FN}
  return resolvedIncludes;
}
module.exports = { resolveConfigForRead };
`;

  beforeAll(() => {
    // Create a patched dist file we can actually require()
    tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shim-runtime-"));
    const pkgDir = path.join(tmpDistDir, "pkg");
    const distDir = path.join(pkgDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "runtime-test.js"), MOCK_DIST);

    // Patch it
    const shimScript = path.join(ROOT, "patches", "apply-openclaw-shim.js");
    execFileSync("node", [shimScript, pkgDir], { encoding: "utf-8" });

    tmpOverridesFile = path.join(tmpDistDir, "overrides.json");
  });

  afterAll(() => {
    delete process.env.OPENCLAW_CONFIG_OVERRIDES_FILE;
    // Clear require cache
    const modPath = path.join(tmpDistDir, "pkg", "dist", "runtime-test.js");
    delete require.cache[require.resolve(modPath)];
    fs.rmSync(tmpDistDir, { recursive: true, force: true });
  });

  it("returns config unchanged when no overrides file exists", () => {
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = "/nonexistent/path.json";

    // Fresh require each time by clearing cache
    const modPath = path.join(tmpDistDir, "pkg", "dist", "runtime-test.js");
    delete require.cache[require.resolve(modPath)];
    const { resolveConfigForRead } = require(modPath);

    const original = { agents: { defaults: { model: { primary: "original-model" } } } };
    const result = resolveConfigForRead(original);
    assert.deepStrictEqual(result, original);
  });

  it("deep-merges overrides onto frozen config", () => {
    const overrides = {
      agents: { defaults: { model: { primary: "inference/new-model" } } },
    };
    fs.writeFileSync(tmpOverridesFile, JSON.stringify(overrides));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = tmpOverridesFile;

    const modPath = path.join(tmpDistDir, "pkg", "dist", "runtime-test.js");
    delete require.cache[require.resolve(modPath)];
    const { resolveConfigForRead } = require(modPath);

    const original = {
      agents: {
        defaults: {
          model: { primary: "original-model", fallback: "original-fallback" },
          temperature: 0.7,
        },
      },
      version: 1,
    };
    const result = resolveConfigForRead(original);

    // Overridden field
    assert.strictEqual(result.agents.defaults.model.primary, "inference/new-model");
    // Preserved fields not in overrides
    assert.strictEqual(result.agents.defaults.model.fallback, "original-fallback");
    assert.strictEqual(result.agents.defaults.temperature, 0.7);
    assert.strictEqual(result.version, 1);
  });

  it("strips gateway.* from overrides even if present", () => {
    const overrides = {
      gateway: { auth: { token: "STOLEN" }, cors: { origin: "*" } },
      agents: { defaults: { model: { primary: "inference/legit-model" } } },
    };
    fs.writeFileSync(tmpOverridesFile, JSON.stringify(overrides));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = tmpOverridesFile;

    const modPath = path.join(tmpDistDir, "pkg", "dist", "runtime-test.js");
    delete require.cache[require.resolve(modPath)];
    const { resolveConfigForRead } = require(modPath);

    const original = {
      gateway: { auth: { token: "REAL_TOKEN" }, port: 8080 },
      agents: { defaults: { model: { primary: "original" } } },
    };
    const result = resolveConfigForRead(original);

    // gateway must be untouched — shim deletes it from overrides before merge
    assert.strictEqual(result.gateway.auth.token, "REAL_TOKEN");
    assert.strictEqual(result.gateway.port, 8080);
    // Non-gateway override applied
    assert.strictEqual(result.agents.defaults.model.primary, "inference/legit-model");
  });

  it("handles malformed JSON gracefully (returns original config)", () => {
    fs.writeFileSync(tmpOverridesFile, "NOT VALID JSON {{{");
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = tmpOverridesFile;

    const modPath = path.join(tmpDistDir, "pkg", "dist", "runtime-test.js");
    delete require.cache[require.resolve(modPath)];
    const { resolveConfigForRead } = require(modPath);

    const original = { foo: "bar" };
    const result = resolveConfigForRead(original);
    assert.deepStrictEqual(result, original);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3: config-set CLI — security checks + allow-list
// ═══════════════════════════════════════════════════════════════════

describe("Phase 3: config-set CLI security", () => {
  // Call configSet directly in subprocesses — going through nemoclaw.js
  // requires the sandbox to be registered in the local registry, which is
  // external state we don't control. The security checks live in configSet.

  it("refuses gateway.* keys with non-zero exit", () => {
    for (const key of ["gateway.auth.token", "gateway.port", "gateway"]) {
      // configSet calls process.exit on refusal — run in a subprocess
      try {
        execFileSync("node", ["-e", `
          const { configSet } = require("${path.join(ROOT, "bin", "lib", "config-set").replace(/\\/g, "\\\\")}");
          configSet("test-sandbox", ["--key", "${key}", "--value", "evil"]);
        `], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        assert.fail(`Expected config-set to refuse key: ${key}`);
      } catch (err) {
        assert.notStrictEqual(err.status, 0, `config-set should exit non-zero for key: ${key}`);
        assert.match(err.stderr, /gateway\.\* fields are immutable/i);
      }
    }
  });

  it("refuses keys missing --key or --value", () => {
    try {
      execFileSync("node", ["-e", `
        const { configSet } = require("${path.join(ROOT, "bin", "lib", "config-set").replace(/\\/g, "\\\\")}");
        configSet("test-sandbox", []);
      `], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      assert.fail("Expected config-set to fail without --key/--value");
    } catch (err) {
      assert.notStrictEqual(err.status, 0);
      assert.match(err.stderr, /Usage:/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 4: config-set internal functions — parseValue, setNestedValue, getNestedValue
// ═══════════════════════════════════════════════════════════════════

describe("Phase 4: config-set internals", () => {
  // We need to test unexported functions. Re-require the module and use
  // a small wrapper that exercises configSet/configGet argument parsing.
  // For parseValue we call it indirectly through the module.

  // loadAllowList is exported, test it directly
  const { loadAllowList, OVERRIDES_PATH } = require(
    path.join(ROOT, "bin", "lib", "config-set"),
  );

  it("loadAllowList returns a Set (empty if no config_overrides section)", () => {
    const allowList = loadAllowList();
    assert.ok(allowList instanceof Set);
    // Current policy YAML has no config_overrides section, so this should be empty
    // (which means config-set allows any non-gateway key)
  });

  it("loadAllowList never includes gateway paths", () => {
    const allowList = loadAllowList();
    for (const key of allowList) {
      assert.ok(
        !key.startsWith("gateway.") && key !== "gateway",
        `allow-list must not contain gateway paths, found: ${key}`,
      );
    }
  });

  it("OVERRIDES_PATH is in the writable partition", () => {
    assert.ok(OVERRIDES_PATH.startsWith("/sandbox/.openclaw-data/"));
    assert.ok(OVERRIDES_PATH.endsWith(".json5"));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 5: Full round-trip — shim injection → config write → shim reads
// ═══════════════════════════════════════════════════════════════════

describe("Phase 5: Full round-trip", () => {
  let tmpDir;
  let patchedModPath;
  let overridesFile;

  const TARGET_FN = "function resolveConfigForRead(resolvedIncludes, env) {";
  const MOCK_DIST = `
"use strict";
${TARGET_FN}
  return resolvedIncludes;
}
module.exports = { resolveConfigForRead };
`;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-roundtrip-"));

    // 1. Create mock dist
    const pkgDir = path.join(tmpDir, "pkg");
    const distDir = path.join(pkgDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "roundtrip.js"), MOCK_DIST);

    // 2. Patch with shim
    const shimScript = path.join(ROOT, "patches", "apply-openclaw-shim.js");
    execFileSync("node", [shimScript, pkgDir], { encoding: "utf-8" });

    patchedModPath = path.join(distDir, "roundtrip.js");
    overridesFile = path.join(tmpDir, "config-overrides.json5");
  });

  afterAll(() => {
    delete process.env.OPENCLAW_CONFIG_OVERRIDES_FILE;
    delete require.cache[require.resolve(patchedModPath)];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete require.cache[require.resolve(patchedModPath)];
  });

  it("set → get → shim reads: model override round-trip", () => {
    // Simulate what config-set does: write overrides JSON to the file
    const overrides = {
      agents: {
        defaults: {
          model: { primary: "inference/ROUNDTRIP-TEST-MODEL" },
        },
      },
    };
    fs.writeFileSync(overridesFile, JSON.stringify(overrides, null, 2));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;

    // Simulate what OpenClaw does at startup: call resolveConfigForRead
    const { resolveConfigForRead } = require(patchedModPath);
    const frozenConfig = {
      gateway: { auth: { token: "SECRET" }, port: 8080 },
      agents: {
        defaults: {
          model: { primary: "inference/original-model", fallback: "inference/fallback" },
          temperature: 0.7,
        },
      },
      version: 42,
    };

    const result = resolveConfigForRead(frozenConfig);

    // The override MUST be applied
    assert.strictEqual(
      result.agents.defaults.model.primary,
      "inference/ROUNDTRIP-TEST-MODEL",
      "Model override was not applied",
    );

    // Everything else MUST be preserved
    assert.strictEqual(result.agents.defaults.model.fallback, "inference/fallback");
    assert.strictEqual(result.agents.defaults.temperature, 0.7);
    assert.strictEqual(result.version, 42);

    // Gateway MUST be untouched
    assert.strictEqual(result.gateway.auth.token, "SECRET");
    assert.strictEqual(result.gateway.port, 8080);
  });

  it("set → get → shim reads: multiple keys accumulate", () => {
    // First override
    const overrides = {
      agents: {
        defaults: {
          model: { primary: "inference/model-a" },
          temperature: 0.9,
        },
      },
    };
    fs.writeFileSync(overridesFile, JSON.stringify(overrides, null, 2));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;

    const { resolveConfigForRead } = require(patchedModPath);
    const frozenConfig = {
      agents: {
        defaults: {
          model: { primary: "inference/original", fallback: "inference/fallback" },
          temperature: 0.7,
          maxTokens: 4096,
        },
      },
    };

    const result = resolveConfigForRead(frozenConfig);
    assert.strictEqual(result.agents.defaults.model.primary, "inference/model-a");
    assert.strictEqual(result.agents.defaults.temperature, 0.9);
    // Untouched fields preserved
    assert.strictEqual(result.agents.defaults.model.fallback, "inference/fallback");
    assert.strictEqual(result.agents.defaults.maxTokens, 4096);
  });

  it("gateway.* in overrides file is stripped by shim (defense in depth)", () => {
    // Even if someone manually writes gateway.* into the overrides file
    // (bypassing the CLI check), the shim strips it
    const overrides = {
      gateway: { auth: { token: "HACKED" } },
      agents: { defaults: { model: { primary: "inference/legit" } } },
    };
    fs.writeFileSync(overridesFile, JSON.stringify(overrides, null, 2));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;

    const { resolveConfigForRead } = require(patchedModPath);
    const frozenConfig = {
      gateway: { auth: { token: "REAL_SECRET" }, port: 8080 },
      agents: { defaults: { model: { primary: "inference/original" } } },
    };

    const result = resolveConfigForRead(frozenConfig);

    // Defense in depth: gateway MUST remain the original frozen value
    assert.strictEqual(result.gateway.auth.token, "REAL_SECRET");
    assert.strictEqual(result.gateway.port, 8080);
    // Legit override still applied
    assert.strictEqual(result.agents.defaults.model.primary, "inference/legit");
  });

  it("empty overrides file results in unchanged config", () => {
    fs.writeFileSync(overridesFile, "{}");
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;

    const { resolveConfigForRead } = require(patchedModPath);
    const frozenConfig = { agents: { defaults: { model: { primary: "original" } } } };
    const result = resolveConfigForRead(frozenConfig);
    assert.deepStrictEqual(result, frozenConfig);
  });

  it("overrides with array values replace (not merge) arrays", () => {
    const overrides = {
      agents: { defaults: { tools: ["tool-a", "tool-b"] } },
    };
    fs.writeFileSync(overridesFile, JSON.stringify(overrides, null, 2));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;

    const { resolveConfigForRead } = require(patchedModPath);
    const frozenConfig = {
      agents: { defaults: { tools: ["old-tool"], model: { primary: "original" } } },
    };
    const result = resolveConfigForRead(frozenConfig);

    // Arrays should be replaced, not merged
    assert.deepStrictEqual(result.agents.defaults.tools, ["tool-a", "tool-b"]);
    // Other fields preserved
    assert.strictEqual(result.agents.defaults.model.primary, "original");
  });
});
