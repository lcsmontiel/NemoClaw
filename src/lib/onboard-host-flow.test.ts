// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { runHostPreparationFlow } from "../../dist/lib/onboard-host-flow";

describe("runHostPreparationFlow", () => {
  it("runs preflight and gateway startup on a fresh flow", async () => {
    const events: string[] = [];
    const startGateway = vi.fn(async () => {
      events.push("start-gateway");
    });

    const result = await runHostPreparationFlow({
      resume: false,
      hasCompletedPreflight: false,
      hasCompletedGateway: false,
      preflight: async () => ({ gpu: "spark" }),
      detectGpu: () => ({ gpu: "cached" }),
      getGatewayStatus: () => "status",
      getNamedGatewayInfo: () => "gw-info",
      getActiveGatewayInfo: () => "active-info",
      getGatewayReuseState: () => "missing",
      verifyGatewayContainerRunning: () => "running",
      stopDashboardForward: () => events.push("stop-forward"),
      destroyGateway: () => events.push("destroy-gateway"),
      clearRegistryAll: () => events.push("clear-registry"),
      startGateway,
      onNote: (message) => events.push(`note:${message}`),
      onLog: (message) => events.push(`log:${message}`),
      onSkip: (step, detail, reason = "resume") => events.push(`skip:${step}:${detail}:${reason}`),
      onStartStep: (step) => events.push(`start:${step}`),
      onCompleteStep: (step) => events.push(`complete:${step}`),
    });

    expect(result).toEqual({ gpu: { gpu: "spark" }, gatewayReuseState: "missing" });
    expect(startGateway).toHaveBeenCalledWith({ gpu: "spark" });
    expect(events).toEqual([
      "start:preflight",
      "complete:preflight",
      "start:gateway",
      "start-gateway",
      "complete:gateway",
    ]);
  });

  it("skips preflight and gateway when resume can reuse a healthy gateway", async () => {
    const events: string[] = [];

    const result = await runHostPreparationFlow({
      resume: true,
      hasCompletedPreflight: true,
      hasCompletedGateway: true,
      preflight: async () => {
        throw new Error("should not rerun preflight");
      },
      detectGpu: () => ({ gpu: "cached" }),
      getGatewayStatus: () => "status",
      getNamedGatewayInfo: () => "gw-info",
      getActiveGatewayInfo: () => "active-info",
      getGatewayReuseState: () => "healthy",
      verifyGatewayContainerRunning: () => "running",
      stopDashboardForward: () => events.push("stop-forward"),
      destroyGateway: () => events.push("destroy-gateway"),
      clearRegistryAll: () => events.push("clear-registry"),
      startGateway: async () => {
        throw new Error("should not rerun gateway");
      },
      onNote: (message) => events.push(`note:${message}`),
      onLog: (message) => events.push(`log:${message}`),
      onSkip: (step, detail, reason = "resume") => events.push(`skip:${step}:${detail}:${reason}`),
      onStartStep: (step) => events.push(`start:${step}`),
      onCompleteStep: (step) => events.push(`complete:${step}`),
    });

    expect(result).toEqual({ gpu: { gpu: "cached" }, gatewayReuseState: "healthy" });
    expect(events).toEqual([
      "skip:preflight:cached:resume",
      "skip:gateway:running:resume",
    ]);
  });

  it("cleans up stale gateway metadata before restarting the gateway", async () => {
    const events: string[] = [];

    const result = await runHostPreparationFlow({
      resume: true,
      hasCompletedPreflight: true,
      hasCompletedGateway: true,
      preflight: async () => {
        throw new Error("should not rerun preflight");
      },
      detectGpu: () => ({ gpu: "cached" }),
      getGatewayStatus: () => "status",
      getNamedGatewayInfo: () => "gw-info",
      getActiveGatewayInfo: () => "active-info",
      getGatewayReuseState: () => "healthy",
      verifyGatewayContainerRunning: () => "missing",
      stopDashboardForward: () => events.push("stop-forward"),
      destroyGateway: () => events.push("destroy-gateway"),
      clearRegistryAll: () => events.push("clear-registry"),
      startGateway: async () => {
        events.push("start-gateway");
      },
      onNote: (message) => events.push(`note:${message}`),
      onLog: (message) => events.push(`log:${message}`),
      onSkip: (step, detail, reason = "resume") => events.push(`skip:${step}:${detail}:${reason}`),
      onStartStep: (step) => events.push(`start:${step}`),
      onCompleteStep: (step) => events.push(`complete:${step}`),
    });

    expect(result).toEqual({ gpu: { gpu: "cached" }, gatewayReuseState: "missing" });
    expect(events).toEqual([
      "skip:preflight:cached:resume",
      "log:  Gateway metadata is stale (container not running). Cleaning up...",
      "stop-forward",
      "destroy-gateway",
      "clear-registry",
      "log:  ✓ Stale gateway metadata cleaned up",
      "note:  [resume] Recorded gateway state is unavailable; recreating it.",
      "start:gateway",
      "start-gateway",
      "complete:gateway",
    ]);
  });

  it("warns and reuses the gateway when Docker state cannot be probed", async () => {
    const events: string[] = [];

    const result = await runHostPreparationFlow({
      resume: false,
      hasCompletedPreflight: true,
      hasCompletedGateway: false,
      preflight: async () => ({ gpu: "fresh" }),
      detectGpu: () => ({ gpu: "cached" }),
      getGatewayStatus: () => "status",
      getNamedGatewayInfo: () => "gw-info",
      getActiveGatewayInfo: () => "active-info",
      getGatewayReuseState: () => "healthy",
      verifyGatewayContainerRunning: () => "unknown",
      stopDashboardForward: () => events.push("stop-forward"),
      destroyGateway: () => events.push("destroy-gateway"),
      clearRegistryAll: () => events.push("clear-registry"),
      startGateway: async () => {
        throw new Error("should not restart gateway when metadata stays healthy");
      },
      onNote: (message) => events.push(`note:${message}`),
      onLog: (message) => events.push(`log:${message}`),
      onSkip: (step, detail, reason = "resume") => events.push(`skip:${step}:${detail}:${reason}`),
      onStartStep: (step) => events.push(`start:${step}`),
      onCompleteStep: (step) => events.push(`complete:${step}`),
    });

    expect(result).toEqual({ gpu: { gpu: "fresh" }, gatewayReuseState: "healthy" });
    expect(events).toEqual([
      "start:preflight",
      "complete:preflight",
      "log:  Warning: could not verify gateway container state (Docker may be unavailable). Proceeding with cached health status.",
      "skip:gateway:running:reuse",
      "note:  Reusing healthy NemoClaw gateway.",
    ]);
  });
});
