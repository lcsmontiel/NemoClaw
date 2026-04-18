// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface TelegramProbeResult {
  ok: boolean;
  httpStatus: number;
  curlStatus: number;
  body: string;
  stderr: string;
  message: string;
}

// Curl exit codes that indicate a network-level failure (not a token problem).
// 35 (TLS handshake failure) covers corporate proxies that MITM HTTPS.
export const TELEGRAM_NETWORK_CURL_CODES = new Set([6, 7, 28, 35, 52, 56]);

export interface CheckTelegramReachabilityDeps {
  runCurlProbe: (args: string[]) => TelegramProbeResult;
  isNonInteractive: () => boolean;
  promptOrDefault: (
    question: string,
    envVar: string | null,
    defaultValue: string,
  ) => Promise<string>;
  log?: (message?: string) => void;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

export async function checkTelegramReachability(
  token: string,
  deps: CheckTelegramReachabilityDeps,
): Promise<void> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const result = deps.runCurlProbe([
    "-sS",
    "--connect-timeout",
    "5",
    "--max-time",
    "10",
    `https://api.telegram.org/bot${token}/getMe`,
  ]);

  if (result.ok) return;

  if (result.httpStatus === 401 || result.httpStatus === 404) {
    log("  ⚠ Bot token was rejected by Telegram — verify the token is correct.");
    return;
  }

  if (result.curlStatus && TELEGRAM_NETWORK_CURL_CODES.has(result.curlStatus)) {
    log("");
    log("  ⚠ api.telegram.org is not reachable from this host.");
    log("    Telegram integration requires outbound HTTPS access to api.telegram.org.");
    log("    This is commonly blocked by corporate network proxies.");

    if (deps.isNonInteractive()) {
      error(
        "  Aborting onboarding in non-interactive mode due to Telegram network reachability failure.",
      );
      exit(1);
    } else {
      const answer = (await deps.promptOrDefault("    Continue anyway? [y/N]: ", null, "n"))
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        log("  Aborting onboarding.");
        exit(1);
      }
    }
    return;
  }

  if (!result.ok && result.httpStatus > 0) {
    log(`  ⚠ Telegram API returned HTTP ${result.httpStatus} — the bot may not work correctly.`);
  } else if (!result.ok) {
    log(`  ⚠ Telegram reachability probe failed: ${result.message}`);
  }
}
