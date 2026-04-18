// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReuseState } from "./gateway-state";

export interface HostPreparationResult<TGpu = unknown> {
  gpu: TGpu;
  gatewayReuseState: GatewayReuseState;
}

export interface HostPreparationDeps<TGpu = unknown> {
  resume: boolean;
  hasCompletedPreflight: boolean;
  hasCompletedGateway: boolean;
  preflight: () => Promise<TGpu>;
  detectGpu: () => TGpu;
  getGatewayStatus: () => string;
  getNamedGatewayInfo: () => string;
  getActiveGatewayInfo: () => string;
  getGatewayReuseState: (
    statusOutput: string,
    gwInfoOutput: string,
    activeGatewayInfoOutput: string,
  ) => GatewayReuseState;
  verifyGatewayContainerRunning: () => "running" | "missing" | "unknown";
  stopDashboardForward: () => void;
  destroyGateway: () => void;
  clearRegistryAll: () => void;
  startGateway: (gpu: TGpu) => Promise<void>;
  onNote: (message: string) => void;
  onLog: (message: string) => void;
  onSkip: (stepName: "preflight" | "gateway", detail: string, reason?: "resume" | "reuse") => void;
  onStartStep: (stepName: "preflight" | "gateway") => void;
  onCompleteStep: (stepName: "preflight" | "gateway") => void;
}

export async function runHostPreparationFlow<TGpu = unknown>(
  deps: HostPreparationDeps<TGpu>,
): Promise<HostPreparationResult<TGpu>> {
  let gpu: TGpu;
  if (deps.resume && deps.hasCompletedPreflight) {
    deps.onSkip("preflight", "cached");
    gpu = deps.detectGpu();
  } else {
    deps.onStartStep("preflight");
    gpu = await deps.preflight();
    deps.onCompleteStep("preflight");
  }

  const gatewayStatus = deps.getGatewayStatus();
  const gatewayInfo = deps.getNamedGatewayInfo();
  const activeGatewayInfo = deps.getActiveGatewayInfo();
  let gatewayReuseState = deps.getGatewayReuseState(gatewayStatus, gatewayInfo, activeGatewayInfo);

  // Verify the gateway container is actually running — openshell CLI metadata
  // can be stale after a manual `docker rm`. See #2020.
  if (gatewayReuseState === "healthy") {
    const containerState = deps.verifyGatewayContainerRunning();
    if (containerState === "missing") {
      deps.onLog("  Gateway metadata is stale (container not running). Cleaning up...");
      deps.stopDashboardForward();
      deps.destroyGateway();
      deps.clearRegistryAll();
      gatewayReuseState = "missing";
      deps.onLog("  ✓ Stale gateway metadata cleaned up");
    } else if (containerState === "unknown") {
      deps.onLog(
        "  Warning: could not verify gateway container state (Docker may be unavailable). Proceeding with cached health status.",
      );
    }
  }

  const canReuseHealthyGateway = gatewayReuseState === "healthy";
  const resumeGateway = deps.resume && deps.hasCompletedGateway && canReuseHealthyGateway;
  if (resumeGateway) {
    deps.onSkip("gateway", "running");
  } else if (!deps.resume && canReuseHealthyGateway) {
    deps.onSkip("gateway", "running", "reuse");
    deps.onNote("  Reusing healthy NemoClaw gateway.");
  } else {
    if (deps.hasCompletedGateway) {
      if (gatewayReuseState === "active-unnamed") {
        deps.onNote("  [resume] Gateway is active but named metadata is missing; recreating it safely.");
      } else if (gatewayReuseState === "foreign-active") {
        deps.onNote("  [resume] A different OpenShell gateway is active; NemoClaw will not reuse it.");
      } else if (gatewayReuseState === "stale") {
        deps.onNote("  [resume] Recorded gateway is unhealthy; recreating it.");
      } else {
        deps.onNote("  [resume] Recorded gateway state is unavailable; recreating it.");
      }
    }
    deps.onStartStep("gateway");
    await deps.startGateway(gpu);
    deps.onCompleteStep("gateway");
  }

  return { gpu, gatewayReuseState };
}
