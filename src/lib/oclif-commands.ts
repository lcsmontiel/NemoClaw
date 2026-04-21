// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createListCommand, type ListCommandClass } from "./list-command";
import { getListCommandDeps } from "./list-command-runtime";

const commands: Record<string, ListCommandClass> = {
  list: createListCommand(getListCommandDeps),
};

export default commands;
