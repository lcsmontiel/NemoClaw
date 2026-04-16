// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Verify shellQuote is applied to sandboxName in shell commands
import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

describe("sandboxName shell quoting in onboard.js", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
    "utf-8",
  );

  it("passes sandboxName as a separate argv element in openshell sandbox exec", () => {
    expect(src).toMatch(
      /\[openshellBin,\s*"sandbox",\s*"exec",\s*sandboxName,/,
    );
  });

  it("passes sandboxName as a separate argv element in setup-dns-proxy.sh command", () => {
    expect(src).toMatch(
      /\["bash",\s*path\.join\(SCRIPTS,\s*"setup-dns-proxy\.sh"\),\s*GATEWAY_NAME,\s*sandboxName\]/,
    );
  });

  it("forwards opts to openshellArgv so openshellBinary overrides are not dropped", () => {
    // Regression guard: runOpenshell and runCaptureOpenshell must pass opts
    // through to openshellArgv. Without this, callers that supply
    // { openshellBinary: customPath } silently fall back to the default binary.
    expect(src).toMatch(/function runOpenshell\(args, opts[^)]*\)\s*\{[^}]*openshellArgv\(args,\s*opts\)/s);
    expect(src).toMatch(/function runCaptureOpenshell\(args, opts[^)]*\)\s*\{[^}]*openshellArgv\(args,\s*opts\)/s);
  });

  it("does not have unquoted sandboxName in runCapture or run calls", () => {
    // Match run()/runCapture() calls that span multiple lines and contain
    // template literals, so multiline invocations are not missed.
    const callPattern = /\b(run|runCapture)\s*\(\s*`([^`]*)`/g;
    const violations = [];
    let match;
    while ((match = callPattern.exec(src)) !== null) {
      const template = match[2];
      if (template.includes("${sandboxName}") && !template.includes("shellQuote(sandboxName)")) {
        const line = src.slice(0, match.index).split("\n").length;
        violations.push(`Line ${line}: ${match[0].slice(0, 120).trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
