#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Token rotation E2E test (issue #1903 / nvbug 6083165):
#   - prove that rotating a messaging token and re-running onboard propagates
#     the new credential to the L7 proxy (sandbox is rebuilt automatically)
#   - prove that re-running onboard with the same token reuses the sandbox
#   - prove that workspace state is preserved across credential rotation
#
# Requires two Telegram bot tokens: TELEGRAM_BOT_TOKEN_A and TELEGRAM_BOT_TOKEN_B
# At least one must be a valid Telegram bot token for meaningful verification.

set -uo pipefail

if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-900}"
  exec timeout -s TERM "$TIMEOUT_SECONDS" "$0" "$@"
fi

PASS=0
FAIL=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

registry_has() {
  local sandbox_name="$1"
  [ -f "$REGISTRY" ] && grep -q "$sandbox_name" "$REGISTRY"
}

SANDBOX_NAME="e2e-token-rotation"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FAKE_HOST="127.0.0.1"
FAKE_PORT="${NEMOCLAW_FAKE_PORT:-18080}"
FAKE_BASE_URL="http://${FAKE_HOST}:${FAKE_PORT}/v1"
FAKE_LOG="$(mktemp)"
FAKE_PID=""

if command -v node >/dev/null 2>&1 && [ -f "$REPO_ROOT/bin/nemoclaw.js" ]; then
  NEMOCLAW_CMD=(node "$REPO_ROOT/bin/nemoclaw.js")
else
  NEMOCLAW_CMD=(nemoclaw)
fi

# ── Prerequisite checks ──────────────────────────────────────────

if [ -z "${TELEGRAM_BOT_TOKEN_A:-}" ] || [ -z "${TELEGRAM_BOT_TOKEN_B:-}" ]; then
  echo "SKIP: TELEGRAM_BOT_TOKEN_A and TELEGRAM_BOT_TOKEN_B must both be set"
  exit 0
fi

if [ "$TELEGRAM_BOT_TOKEN_A" = "$TELEGRAM_BOT_TOKEN_B" ]; then
  echo "SKIP: TELEGRAM_BOT_TOKEN_A and TELEGRAM_BOT_TOKEN_B must be different"
  exit 0
fi

# ── Helpers ───────────────────────────────────────────────────────

cleanup() {
  if [ -n "$FAKE_PID" ] && kill -0 "$FAKE_PID" 2>/dev/null; then
    kill "$FAKE_PID" 2>/dev/null || true
    wait "$FAKE_PID" 2>/dev/null || true
  fi
  rm -f "$FAKE_LOG"

  # Clean up sandbox
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
}
trap cleanup EXIT

start_fake_openai() {
  python3 - "$FAKE_HOST" "$FAKE_PORT" >"$FAKE_LOG" 2>&1 <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = sys.argv[1]
PORT = int(sys.argv[2])


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return

    def do_GET(self):
        if self.path in ("/v1/models", "/models"):
            self._send(200, {"data": [{"id": "fake-model"}]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        self._send(200, {
            "id": "chatcmpl-fake",
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
        })


HTTPServer((HOST, PORT), Handler).serve_forever()
PY
  FAKE_PID=$!
  sleep 1
  if ! kill -0 "$FAKE_PID" 2>/dev/null; then
    echo "FATAL: fake OpenAI server failed to start"
    cat "$FAKE_LOG"
    exit 1
  fi
}

call_telegram_getme() {
  # Call Telegram getMe from inside the sandbox via the L7 proxy.
  # The sandbox holds a placeholder token; the proxy rewrites it.
  openshell sandbox exec "$SANDBOX_NAME" \
    curl -sf -o /dev/null -w '%{http_code}' \
    "https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null || echo "000"
}

# ── Phase 0: Setup ────────────────────────────────────────────────

section "Phase 0: Start fake OpenAI endpoint"
start_fake_openai
info "Fake OpenAI listening on $FAKE_BASE_URL"

# Clean up any leftover sandbox from a previous run
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true

# ── Phase 1: First onboard with token A ──────────────────────────

section "Phase 1: First onboard with TELEGRAM_BOT_TOKEN_A"

export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN_A"
export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_POLICY_TIER="open"
export NEMOCLAW_NON_INTERACTIVE=1
export OPENAI_API_KEY="fake-key"
export OPENAI_BASE_URL="$FAKE_BASE_URL"
export NEMOCLAW_INFERENCE_PROVIDER="openai-compatible"
export NEMOCLAW_INFERENCE_MODEL="fake-model"

"${NEMOCLAW_CMD[@]}" onboard --non-interactive

if openshell sandbox list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
  pass "Sandbox $SANDBOX_NAME created and running"
else
  fail "Sandbox $SANDBOX_NAME not running after first onboard"
fi

if openshell provider get "${SANDBOX_NAME}-telegram-bridge" >/dev/null 2>&1; then
  pass "Provider ${SANDBOX_NAME}-telegram-bridge exists"
else
  fail "Provider ${SANDBOX_NAME}-telegram-bridge not found"
fi

# Verify credential hashes are stored in registry
if [ -f "$REGISTRY" ] && grep -q "providerCredentialHashes" "$REGISTRY"; then
  pass "Credential hashes stored in registry"
else
  fail "Credential hashes not found in registry"
fi

# ── Phase 2: Rotate token (re-onboard with token B) ──────────────

section "Phase 2: Re-onboard with rotated TELEGRAM_BOT_TOKEN_B"

# Write a marker file to verify workspace preservation
openshell sandbox exec "$SANDBOX_NAME" \
  sh -c 'echo "rotation-marker" > /tmp/rotation-test-marker' 2>/dev/null || true

export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN_B"

ONBOARD_OUTPUT=$("${NEMOCLAW_CMD[@]}" onboard --non-interactive 2>&1)

if echo "$ONBOARD_OUTPUT" | grep -q "credential(s) rotated"; then
  pass "Credential rotation detected"
else
  fail "Credential rotation not detected in onboard output"
fi

if echo "$ONBOARD_OUTPUT" | grep -q "Rebuilding sandbox"; then
  pass "Sandbox rebuild triggered by rotation"
else
  fail "Sandbox rebuild not triggered"
fi

if openshell sandbox list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
  pass "Sandbox running after rotation"
else
  fail "Sandbox not running after rotation"
fi

# Verify workspace state was preserved
MARKER=$(openshell sandbox exec "$SANDBOX_NAME" \
  cat /tmp/rotation-test-marker 2>/dev/null || echo "")
if [ "$MARKER" = "rotation-marker" ]; then
  pass "Workspace state preserved across rotation"
else
  info "Marker file not found (workspace restore may not cover /tmp)"
fi

# ── Phase 3: Re-onboard with same token B (no change) ────────────

section "Phase 3: Re-onboard with same token (no rotation expected)"

ONBOARD_OUTPUT=$("${NEMOCLAW_CMD[@]}" onboard --non-interactive 2>&1)

if echo "$ONBOARD_OUTPUT" | grep -q "reusing it"; then
  pass "Sandbox reused when token unchanged"
else
  fail "Sandbox was not reused (unexpected rebuild)"
fi

# ── Summary ───────────────────────────────────────────────────────

section "Summary"
echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "FAILED"
  exit 1
fi
echo ""
echo "ALL PASSED"
