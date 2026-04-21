#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Start NemoClaw auxiliary services: IRC bridge and cloudflared tunnel
# for public access.
#
# Messaging channels (Telegram, Discord, Slack) are handled natively
# by OpenClaw inside the sandbox — no host-side bridges needed for those.
# IRC has no native channel and remains a host-side bridge.
# See: nemoclaw-start.sh configure_messaging_channels()
#
# Usage:
#   IRC_SERVER=... ./scripts/start-services.sh       # start all
#   ./scripts/start-services.sh --status             # check status
#   ./scripts/start-services.sh --stop               # stop all
#   ./scripts/start-services.sh --sandbox mybox      # start for specific sandbox

set -euo pipefail

DASHBOARD_PORT="${DASHBOARD_PORT:-18789}"

# ── Parse flags ──────────────────────────────────────────────────
SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"
ACTION="start"

while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox)
      SANDBOX_NAME="${2:?--sandbox requires a name}"
      shift 2
      ;;
    --stop)
      ACTION="stop"
      shift
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

PIDDIR="/tmp/nemoclaw-services-${SANDBOX_NAME}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[services]${NC} $1"; }
warn() { echo -e "${YELLOW}[services]${NC} $1"; }
fail() {
  echo -e "${RED}[services]${NC} $1"
  exit 1
}

is_running() {
  local pidfile="$PIDDIR/$1.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    return 0
  fi
  return 1
}

start_service() {
  local name="$1"
  shift
  if is_running "$name"; then
    info "$name already running (PID $(cat "$PIDDIR/$name.pid"))"
    return 0
  fi
  nohup "$@" >"$PIDDIR/$name.log" 2>&1 &
  echo $! >"$PIDDIR/$name.pid"
  info "$name started (PID $!)"
}

stop_service() {
  local name="$1"
  local pidfile="$PIDDIR/$name.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
      info "$name stopped (PID $pid)"
    else
      info "$name was not running"
    fi
    rm -f "$pidfile"
  else
    info "$name was not running"
  fi
}

show_status() {
  mkdir -p "$PIDDIR"
  echo ""
  for svc in irc-bridge cloudflared; do
    if is_running "$svc"; then
      echo -e "  ${GREEN}●${NC} $svc  (PID $(cat "$PIDDIR/$svc.pid"))"
    else
      echo -e "  ${RED}●${NC} $svc  (stopped)"
    fi
  done
  echo ""

  if [ -f "$PIDDIR/cloudflared.log" ]; then
    local url
    url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$PIDDIR/cloudflared.log" 2>/dev/null | head -1 || true)"
    if [ -n "$url" ]; then
      info "Public URL: $url"
    fi
  fi
}

do_stop() {
  mkdir -p "$PIDDIR"
  stop_service cloudflared
  stop_service irc-bridge
  info "All services stopped."
}

do_start() {
  mkdir -p "$PIDDIR"

  if [ -z "${IRC_SERVER:-}" ]; then
    warn "IRC_SERVER not set — IRC bridge will not start."
    warn "Set IRC_SERVER, IRC_NICK, and IRC_CHANNELS to enable."
  fi

  if [ -z "${NVIDIA_API_KEY:-}" ]; then
    warn "NVIDIA_API_KEY not set — IRC bridge requires it for inference."
  fi

  command -v node >/dev/null || fail "node not found. Install Node.js first."

  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  # IRC bridge (only if server and API key are configured)
  if [ -n "${IRC_SERVER:-}" ] && [ -n "${NVIDIA_API_KEY:-}" ]; then
    SANDBOX_NAME="$SANDBOX_NAME" start_service irc-bridge \
      node "$REPO_DIR/scripts/irc-bridge.js"
  fi

  # cloudflared tunnel
  if command -v cloudflared >/dev/null 2>&1; then
    start_service cloudflared \
      cloudflared tunnel --url "http://localhost:$DASHBOARD_PORT"
  else
    warn "cloudflared not found — no public URL. Install it separately if you need a public tunnel."
  fi

  # Wait for cloudflared to publish URL
  if is_running cloudflared; then
    info "Waiting for tunnel URL..."
    for _ in $(seq 1 15); do
      local url
      url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$PIDDIR/cloudflared.log" 2>/dev/null | head -1 || true)"
      if [ -n "$url" ]; then
        break
      fi
      sleep 1
    done
  fi

  # Print banner
  echo ""
  echo "  ┌─────────────────────────────────────────────────────┐"
  echo "  │  NemoClaw Services                                  │"
  echo "  │                                                     │"

  local tunnel_url=""
  if [ -f "$PIDDIR/cloudflared.log" ]; then
    tunnel_url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$PIDDIR/cloudflared.log" 2>/dev/null | head -1 || true)"
  fi

  if [ -n "$tunnel_url" ]; then
    printf "  │  Public URL:  %-40s│\n" "$tunnel_url"
  fi

  echo "  │  Messaging:   via OpenClaw native channels (if configured) │"

  if is_running irc-bridge; then
    echo "  │  IRC:         bridge running                        │"
  else
    echo "  │  IRC:         not started (no server)               │"
  fi

  echo "  │                                                     │"
  echo "  │  Run 'openshell term' to monitor egress approvals   │"
  echo "  └─────────────────────────────────────────────────────┘"
  echo ""
}

# Dispatch
case "$ACTION" in
  stop) do_stop ;;
  status) show_status ;;
  start) do_start ;;
esac
