// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { safeMkdirSync } from "../lib/safe-dir.js";

let configDir = join(homedir(), ".nemoclaw");

export type EndpointType =
  | "build"
  | "openai"
  | "anthropic"
  | "gemini"
  | "ncp"
  | "nim-local"
  | "vllm"
  | "ollama"
  | "custom";

export interface NemoClawOnboardConfig {
  endpointType: EndpointType;
  endpointUrl: string;
  ncpPartner: string | null;
  model: string;
  profile: string;
  credentialEnv: string;
  provider?: string;
  providerLabel?: string;
  onboardedAt: string;
}

export function describeOnboardEndpoint(config: NemoClawOnboardConfig): string {
  if (config.endpointUrl === "https://inference.local/v1") {
    return "Managed Inference Route (inference.local)";
  }

  return `${config.endpointType} (${config.endpointUrl})`;
}

export function describeOnboardProvider(config: NemoClawOnboardConfig): string {
  if (config.providerLabel) {
    return config.providerLabel;
  }

  switch (config.endpointType) {
    case "build":
      return "NVIDIA Endpoints";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Google Gemini";
    case "ollama":
      return "Local Ollama";
    case "vllm":
      return "Local vLLM";
    case "nim-local":
      return "Local NVIDIA NIM";
    case "ncp":
      return "NVIDIA Cloud Partner";
    case "custom":
      return "Other OpenAI-compatible endpoint";
    default:
      return "Unknown";
  }
}

let configDirCreated = false;

function ensureConfigDir(): void {
  if (configDirCreated) return;
  try {
    safeMkdirSync(configDir);
  } catch (error: unknown) {
    // Never swallow symlink errors — they indicate an attack.
    if (error instanceof Error && /symbolic link/i.test(error.message)) {
      throw error;
    }
    // Fall back to tmpdir only for permission/filesystem errors.
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EACCES", "EPERM", "EROFS"].includes(code)) {
      throw error;
    }
    configDir = join(tmpdir(), ".nemoclaw");
    safeMkdirSync(configDir);
  }
  configDirCreated = true;
}

function configPath(): string {
  return join(configDir, "config.json");
}

export function loadOnboardConfig(): NemoClawOnboardConfig | null {
  ensureConfigDir();
  const path = configPath();
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as NemoClawOnboardConfig;
}

export function saveOnboardConfig(config: NemoClawOnboardConfig): void {
  ensureConfigDir();
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

export function clearOnboardConfig(): void {
  const path = configPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
