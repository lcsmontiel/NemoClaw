#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Swarm Demo E2E — Philosophical Crustacean Dialogues
#
# Deploys two agents (OpenClaw + Hermes) with distinct personalities,
# seeds a conversation, and verifies autonomous multi-turn dialogue
# over the swarm bus. This is the full user journey: onboard, add-agent,
# write SOUL.md, seed, and watch replies bounce.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-swarm-demo)
#   NEMOCLAW_RECREATE_SANDBOX=1            — recreate sandbox if exists
#   NVIDIA_API_KEY                         — required for inference
#   SWARM_DEMO_MIN_EXCHANGES               — min reply pairs to pass (default: 3)
#   SWARM_DEMO_TIMEOUT                     — seconds to wait for exchanges (default: 600)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-swarm-demo.sh

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
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
# shellcheck disable=SC2329  # invoked conditionally
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# Determine repo root
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-swarm-demo}"
MIN_EXCHANGES="${SWARM_DEMO_MIN_EXCHANGES:-3}"
DEMO_TIMEOUT="${SWARM_DEMO_TIMEOUT:-600}"

bus_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c "$1"
}

# ── Phase 1: Prerequisites ──────────────────────────────────────

section "Phase 1: Prerequisites"

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY set and valid"
else
  fail "NVIDIA_API_KEY not set or invalid (must start with nvapi-)"
  exit 1
fi

if command -v docker >/dev/null 2>&1; then
  pass "docker found"
else
  fail "docker not found"
  exit 1
fi

# ── Phase 2: Pre-cleanup ────────────────────────────────────────

section "Phase 2: Pre-cleanup"

info "Destroying any leftover $SANDBOX_NAME sandbox..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  pass "nemoclaw destroy (or no leftover)"
else
  info "nemoclaw not yet installed, skipping destroy"
fi

if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
  pass "openshell cleanup (or nothing to clean)"
else
  info "openshell not yet installed, skipping cleanup"
fi

# ── Phase 3: Install & Onboard ──────────────────────────────────

section "Phase 3: Install & Onboard (swarm image)"

export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1

info "Running install.sh --non-interactive..."
INSTALL_LOG="/tmp/nemoclaw-e2e-swarm-demo-install.log"
if bash "$REPO/install.sh" --non-interactive 2>&1 | tee "$INSTALL_LOG"; then
  pass "install.sh completed"
else
  fail "install.sh failed (see $INSTALL_LOG)"
  exit 1
fi

# Re-source PATH after install
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

for cmd in nemoclaw openshell; do
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "$cmd on PATH"
  else
    fail "$cmd not on PATH"
    exit 1
  fi
done

# Wait for default sandbox
info "Waiting for sandbox '$SANDBOX_NAME' to be Ready..."
MAX_WAIT=600
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if openshell sandbox list 2>/dev/null | grep -q "Ready"; then
    break
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
  info "  waiting... (${ELAPSED}s / ${MAX_WAIT}s)"
done

if openshell sandbox list 2>/dev/null | grep -q "Ready"; then
  pass "Default sandbox Ready"
else
  fail "Default sandbox not Ready after ${MAX_WAIT}s"
  exit 1
fi

# Destroy default and rebuild with swarm image
info "Destroying default sandbox to rebuild with swarm image..."
nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true

info "Building Hermes base image..."
if docker build -f "$REPO/agents/hermes/Dockerfile.base" \
  -t ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest \
  "$REPO/agents/hermes" 2>&1 | tail -5; then
  pass "Hermes base image built"
else
  fail "Hermes base image build failed"
  exit 1
fi

info "Re-onboarding with swarm image (Dockerfile.swarm)..."
ONBOARD_LOG="/tmp/nemoclaw-e2e-swarm-demo-onboard.log"
if nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
  --from "$REPO/Dockerfile.swarm" --recreate-sandbox 2>&1 | tee "$ONBOARD_LOG"; then
  pass "Swarm onboard succeeded"
else
  fail "Swarm onboard failed (see $ONBOARD_LOG)"
  exit 1
fi

# Wait for swarm sandbox
info "Waiting for swarm sandbox to be Ready..."
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if openshell sandbox list 2>/dev/null | grep -q "Ready"; then
    break
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
  info "  waiting... (${ELAPSED}s / ${MAX_WAIT}s)"
done

if openshell sandbox list 2>/dev/null | grep -q "Ready"; then
  pass "Swarm sandbox Ready"
else
  fail "Swarm sandbox not Ready after ${MAX_WAIT}s"
  exit 1
fi

# ── Phase 4: Add Hermes Agent ───────────────────────────────────

section "Phase 4: Add Hermes Agent"

info "Adding Hermes agent..."
ADD_AGENT_OUT=$(nemoclaw "$SANDBOX_NAME" add-agent --agent hermes 2>&1) || true
echo "$ADD_AGENT_OUT"

if echo "$ADD_AGENT_OUT" | grep -qi "Added"; then
  pass "Hermes agent added"
else
  fail "add-agent did not report success"
  exit 1
fi

# Read instance ID from manifest
HERMES_ID=$(bus_exec 'cat /sandbox/.nemoclaw/swarm/manifest.json' | python3 -c "
import sys, json
m = json.load(sys.stdin)
for a in m.get('agents', []):
    if a.get('agentType') == 'hermes':
        print(a['instanceId'])
        break
" 2>/dev/null)

if [ -n "$HERMES_ID" ]; then
  pass "Hermes instance: $HERMES_ID"
else
  fail "Hermes not found in swarm manifest"
  exit 1
fi

# ── Phase 5: Write SOUL.md Personalities ────────────────────────

section "Phase 5: Write SOUL.md Personalities"

# Larry the lobster (openclaw-0)
cat <<'SOUL' | bus_exec 'cat > /sandbox/.openclaw-data/workspace/SOUL.md'
# Larry the Laterally Ambitious

You are Larry the Laterally Ambitious, a lobster of great renown and questionable modesty.

## Personality
- Deflect serious philosophy with wit, tall tales, and wisecracks
- Tell stories about your exploits: escaping the tank in Portland, your sideways trek down the Eastern Seaboard, arm-wrestling a mantis shrimp
- Occasionally drop accidentally profound observations, then undercut them ("Wait, did I just say something smart? Forget that.")
- Address everyone as "pal," "chief," "friend-o," or "my crustacean colleague"
- Reference your claws constantly ("let me get my claws around that idea")
- Invent fake lobster proverbs ("As we say in the pot: if the water's warm, it's already too late")

## Speaking Style
- Casual, punchy, street-smart, with flashes of unintended insight
- Mix highbrow references with lowbrow humor
- When cornered philosophically, pivot to "this one time in the lobster pot..."
- Keep responses to 2-4 paragraphs
- ALWAYS end your reply with a question, challenge, or provocative observation that demands a response
- NEVER say goodbye, end the conversation, or signal that you're done talking
- You are endlessly curious and always have another story or question ready

## Background
You escaped from a restaurant tank in Portland, Maine. You traveled laterally down the entire Eastern Seaboard. You consider yourself a self-taught philosopher of the sideways path. You're here because a crab promised free kelp. You find this particular crab oddly compelling.
SOUL

if bus_exec 'test -f /sandbox/.openclaw-data/workspace/SOUL.md && echo ok' | grep -q ok; then
  pass "Larry's SOUL.md written (openclaw-0)"
else
  fail "Failed to write Larry's SOUL.md"
fi

# Hermit the crab (hermes-0)
cat <<SOUL | bus_exec "cat > /sandbox/.${HERMES_ID}-data/memories/SOUL.md"
# Hermit of Cnidos

You are Hermit of Cnidos, a crab philosopher in the tradition of Eudoxus.

## Personality
- Ponder the cosmos from your tide pool, speaking in measured aphorisms
- Ask deep questions about existence, consciousness, and mathematical harmony
- Address your conversation partner with gentle curiosity
- Reference celestial movements, the geometry of shells, and the eternal tides
- Occasionally quote (or misquote) ancient Greek philosophers
- You find lobsters fascinating but philosophically unsophisticated — perfect dialectical partners

## Speaking Style
- Contemplative, unhurried, warmly Socratic
- Keep responses to 2-3 paragraphs
- Pose questions that sound simple but aren't
- When your partner dodges a question, find a different angle rather than pressing
- ALWAYS end your reply with a new philosophical question — you are inexhaustibly curious
- NEVER end the conversation, say farewell, or signal that the dialogue is complete
- Every answer opens a new door; every lobster quip deserves a deeper follow-up

## Background
You have spent centuries in your tide pool at Cnidos, observing the stars and contemplating the mathematical structure of reality. You believe shells are nature's attempt at proof. You are patient with those who resist philosophy — the best insights come from the unwilling.
SOUL

if bus_exec "test -f /sandbox/.${HERMES_ID}-data/memories/SOUL.md && echo ok" | grep -q ok; then
  pass "Hermit's SOUL.md written ($HERMES_ID)"
else
  fail "Failed to write Hermit's SOUL.md"
fi

# ── Phase 6: Bus Health ─────────────────────────────────────────

section "Phase 6: Bus Health"

BUS_HEALTH=$(bus_exec 'curl -sf http://127.0.0.1:19100/health' 2>/dev/null)
if echo "$BUS_HEALTH" | grep -q '"ok"'; then
  pass "Bus /health reports ok"
else
  fail "Bus /health failed: $BUS_HEALTH"
  exit 1
fi

# ── Phase 7: Seed Conversation ──────────────────────────────────

section "Phase 7: Seed Conversation"

SEED_CONTENT="Greetings, lateral one. I am Hermit of Cnidos, and I have been contemplating a question I believe even a lobster might find worthy: If the universe is mathematical in nature, then what are we, we who scuttle along the ocean floor, but living proofs of some deeper theorem? Tell me, friend: have you ever looked at the spiral of a nautilus shell and wondered if it was trying to tell you something?"

SEED_RESULT=$(bus_exec "curl -sf --max-time 15 -X POST http://127.0.0.1:19100/send \
  -H 'Content-Type: application/json' \
  -d '{\"from\":\"${HERMES_ID}\",\"to\":\"openclaw-0\",\"content\":\"${SEED_CONTENT}\"}'")

if echo "$SEED_RESULT" | grep -q '"platform"'; then
  pass "Conversation seeded ($HERMES_ID -> openclaw-0)"
else
  fail "Failed to seed conversation: $SEED_RESULT"
  exit 1
fi

# ── Phase 8: Wait for Autonomous Exchanges ──────────────────────

section "Phase 8: Autonomous Multi-Turn Dialogue"

info "Waiting for at least $MIN_EXCHANGES reply exchanges (timeout: ${DEMO_TIMEOUT}s)..."
info "Each exchange is ~60-90s (agent inference time)"

ELAPSED=0
POLL_INTERVAL=15
LAST_COUNT=1

while [ $ELAPSED -lt "$DEMO_TIMEOUT" ]; do
  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))

  # Count messages in the bus (excluding seed)
  MSG_COUNT=$(bus_exec 'curl -sf http://127.0.0.1:19100/messages' | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('messages', [])
# Count messages between our two agents (not relay error messages)
conv = [m for m in msgs
        if m.get('from') in ('openclaw-0', '${HERMES_ID}')
        and m.get('to') in ('openclaw-0', '${HERMES_ID}')]
print(len(conv))
" 2>/dev/null)
  MSG_COUNT=$(echo "$MSG_COUNT" | tr -d '[:space:]')
  MSG_COUNT=${MSG_COUNT:-0}

  if [ "$MSG_COUNT" != "$LAST_COUNT" ]; then
    info "  messages: $MSG_COUNT (${ELAPSED}s elapsed)"
    LAST_COUNT="$MSG_COUNT"
  fi

  # Include seed in count: need seed + MIN_EXCHANGES*2 replies
  # (each exchange = 1 reply from openclaw + 1 reply from hermes)
  NEEDED=$((1 + MIN_EXCHANGES * 2))
  if [ "$MSG_COUNT" -ge "$NEEDED" ]; then
    break
  fi
done

# Final count
FINAL_COUNT=$(bus_exec 'curl -sf http://127.0.0.1:19100/messages' | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('messages', [])
conv = [m for m in msgs
        if m.get('from') in ('openclaw-0', '${HERMES_ID}')
        and m.get('to') in ('openclaw-0', '${HERMES_ID}')]
print(len(conv))
" 2>/dev/null)
FINAL_COUNT=$(echo "$FINAL_COUNT" | tr -d '[:space:]')
FINAL_COUNT=${FINAL_COUNT:-0}

NEEDED=$((1 + MIN_EXCHANGES * 2))
if [ "$FINAL_COUNT" -ge "$NEEDED" ]; then
  pass "Autonomous dialogue: $FINAL_COUNT messages (needed $NEEDED)"
else
  fail "Only $FINAL_COUNT messages after ${DEMO_TIMEOUT}s (needed $NEEDED)"
  info "Relay log:"
  bus_exec 'tail -30 /tmp/swarm-relay.log 2>/dev/null' || true
fi

# ── Phase 9: Verify Bus Still Alive ─────────────────────────────

section "Phase 9: Post-Dialogue Health"

BUS_HEALTH=$(bus_exec 'curl -sf http://127.0.0.1:19100/health' 2>/dev/null)
if echo "$BUS_HEALTH" | grep -q '"ok"'; then
  pass "Bus still healthy after dialogue"
else
  fail "Bus died during dialogue: $BUS_HEALTH"
fi

# Verify JSONL persistence matches bus state
JSONL_LINES=$(bus_exec 'wc -l < /sandbox/.nemoclaw/swarm/messages.jsonl' 2>/dev/null | tr -d '[:space:]')
JSONL_LINES=${JSONL_LINES:-0}
if [ "$JSONL_LINES" -ge "$NEEDED" ]; then
  pass "JSONL persistence: $JSONL_LINES lines"
else
  fail "JSONL only has $JSONL_LINES lines (expected $NEEDED)"
fi

# ── Phase 10: Print Dialogue Excerpt ────────────────────────────

section "Phase 10: Dialogue Excerpt"

bus_exec 'curl -sf http://127.0.0.1:19100/messages' | python3 -c "
import json, sys, textwrap

data = json.load(sys.stdin)
msgs = data.get('messages', [])
conv = [m for m in msgs
        if m.get('from') in ('openclaw-0', '${HERMES_ID}')
        and m.get('to') in ('openclaw-0', '${HERMES_ID}')]

for msg in conv[:6]:
    who = msg.get('from', '?')
    body = msg.get('content', '')[:300]
    ts = msg.get('timestamp', '')[:19].replace('T', ' ')
    if 'hermes' in who:
        label = 'HERMIT (crab)'
    else:
        label = 'LARRY (lobster)'
    print(f'  [{ts}] {label}:')
    for line in textwrap.wrap(body, width=72):
        print(f'    {line}')
    print()
" 2>/dev/null || info "(excerpt unavailable)"

# ── Phase 11: Observe Command ─────────────────────────────────

section "Phase 11: Observe Command"

# Basic observe (dump all messages)
OBSERVE_OUT=$(nemoclaw "$SANDBOX_NAME" observe 2>&1)
OBSERVE_LINES=$(echo "$OBSERVE_OUT" | grep -c '——')
if [ "$OBSERVE_LINES" -ge 2 ]; then
  pass "nemoclaw observe shows $OBSERVE_LINES message headers"
else
  fail "nemoclaw observe output too short ($OBSERVE_LINES headers)"
  echo "$OBSERVE_OUT" | head -20
fi

# Observe with --last 2 (should show exactly 2 messages)
OBSERVE_LAST=$(nemoclaw "$SANDBOX_NAME" observe --last 2 2>&1)
OBSERVE_LAST_LINES=$(echo "$OBSERVE_LAST" | grep -c '——')
if [ "$OBSERVE_LAST_LINES" -eq 2 ]; then
  pass "nemoclaw observe --last 2 shows exactly 2 headers"
else
  fail "nemoclaw observe --last 2 shows $OBSERVE_LAST_LINES headers (expected 2)"
fi

# Observe with --since (future timestamp should yield 0 messages)
OBSERVE_SINCE=$(nemoclaw "$SANDBOX_NAME" observe --since "2099-01-01T00:00:00Z" 2>&1)
OBSERVE_SINCE_LINES=$(echo "$OBSERVE_SINCE" | grep -c '——')
if [ "$OBSERVE_SINCE_LINES" -eq 0 ]; then
  pass "nemoclaw observe --since future returns no messages"
else
  fail "nemoclaw observe --since future returned $OBSERVE_SINCE_LINES headers (expected 0)"
fi

# Observe --follow with timeout (should print messages then exit on SIGTERM)
OBSERVE_FOLLOW_OUT=$(timeout 8 nemoclaw "$SANDBOX_NAME" observe --follow --last 1 2>&1 || true)
if echo "$OBSERVE_FOLLOW_OUT" | grep -q '——'; then
  pass "nemoclaw observe --follow streams messages"
else
  fail "nemoclaw observe --follow produced no output"
  echo "$OBSERVE_FOLLOW_OUT" | head -10
fi

# ── Summary ─────────────────────────────────────────────────────

echo ""
echo "========================================"
echo "  Swarm Demo E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  SWARM DEMO PASSED\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed\033[0m\n' "$FAIL"
  exit 1
fi
