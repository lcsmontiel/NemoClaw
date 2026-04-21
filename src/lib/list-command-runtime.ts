// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunListCommandDeps } from "./list-command";

let listCommandDepsProvider: (() => RunListCommandDeps) | null = null;

export function setListCommandDepsProvider(provider: () => RunListCommandDeps): void {
  listCommandDepsProvider = provider;
}

export function clearListCommandDepsProvider(): void {
  listCommandDepsProvider = null;
}

export function getListCommandDeps(): RunListCommandDeps {
  if (!listCommandDepsProvider) {
    throw new Error("list command runtime dependency provider is not configured");
  }

  return listCommandDepsProvider();
}
