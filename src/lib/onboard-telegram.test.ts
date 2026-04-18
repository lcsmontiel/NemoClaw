// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  checkTelegramReachability,
  TELEGRAM_NETWORK_CURL_CODES,
} from "../../dist/lib/onboard-telegram";

describe("onboard-telegram", () => {
  it("defines the expected curl codes for network-level Telegram failures", () => {
    expect([...TELEGRAM_NETWORK_CURL_CODES]).toEqual([6, 7, 28, 35, 52, 56]);
  });

  it("aborts in non-interactive mode on network failures", async () => {
    await expect(
      checkTelegramReachability("fake-token", {
        runCurlProbe: () => ({
          ok: false,
          httpStatus: 0,
          curlStatus: 52,
          body: "",
          stderr: "Empty reply from server",
          message: "curl failed (exit 52): Empty reply from server",
        }),
        isNonInteractive: () => true,
        promptOrDefault: async () => "n",
        log: vi.fn(),
        error: vi.fn(),
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).rejects.toThrow("exit:1");
  });

  it("warns on HTTP token rejection and succeeds silently on HTTP 200", async () => {
    const logs: string[] = [];
    await checkTelegramReachability("bad-token", {
      runCurlProbe: () => ({
        ok: false,
        httpStatus: 401,
        curlStatus: 0,
        body: "",
        stderr: "",
        message: "HTTP 401",
      }),
      isNonInteractive: () => true,
      promptOrDefault: async () => "n",
      log: (message = "") => logs.push(message),
      error: vi.fn(),
      exit: ((code: number) => {
        throw new Error(`exit:${code}`);
      }) as never,
    });
    expect(logs).toContain("  ⚠ Bot token was rejected by Telegram — verify the token is correct.");

    const successLogs: string[] = [];
    await checkTelegramReachability("valid-token", {
      runCurlProbe: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: '{"ok":true}',
        stderr: "",
        message: "",
      }),
      isNonInteractive: () => true,
      promptOrDefault: async () => "n",
      log: (message = "") => successLogs.push(message),
      error: vi.fn(),
      exit: ((code: number) => {
        throw new Error(`exit:${code}`);
      }) as never,
    });
    expect(successLogs).toEqual([]);
  });
});
