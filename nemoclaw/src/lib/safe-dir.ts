// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

/**
 * Reject symlinks in the path tree between `dirPath` and the user's home dir.
 *
 * Walks from `dirPath` upward, stopping at $HOME. For each component:
 *   - If it exists as a symlink: throw (attack detected).
 *   - If it exists as a real directory: stop (trusted anchor).
 *   - If it doesn't exist (ENOENT): continue upward.
 *
 * Stops at $HOME because system-level symlinks above it (e.g. /tmp -> /private/tmp
 * on macOS, /var -> /private/var) are trusted OS infrastructure. Paths outside
 * $HOME (e.g. tmpdir fallback) skip the check entirely — those are low-trust
 * shared directories where the threat model is different.
 *
 * @throws if any path component at or below $HOME is a symbolic link.
 */
function rejectSymlink(dirPath: string): void {
  const home = resolve(homedir());
  let current = resolve(dirPath);
  let parent = dirname(current);
  while (current !== parent) {
    // Only check paths at or below $HOME — above is trusted OS infrastructure.
    if (!current.startsWith(home + sep) && current !== home) break;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Refusing to use ${dirPath}: ${current} is a symbolic link. ` +
            "This may indicate a symlink attack. Remove the symlink and retry.",
        );
      }
      // Exists as a real directory — trusted anchor, stop walking.
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Doesn't exist yet — will be created by mkdirSync. Check parent.
    }
    if (current === home) break; // checked $HOME itself, don't go above
    current = parent;
    parent = dirname(current);
  }
}

/**
 * Create a directory after verifying no path component is a symlink.
 *
 * Drop-in replacement for `mkdirSync(path, { recursive: true })` that
 * checks path components (at or below $HOME) with `lstat()` before creating.
 */
export function safeMkdirSync(dirPath: string, options?: { mode?: number }): void {
  rejectSymlink(dirPath);
  mkdirSync(dirPath, { recursive: true, ...options });
}
