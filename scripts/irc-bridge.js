#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * IRC → NemoClaw bridge.
 *
 * Connects to an IRC server over TLS (default) or plain TCP,
 * joins configured channels, and forwards messages to the OpenClaw
 * agent running inside the sandbox. Responses are sent back to the
 * originating channel or user.
 *
 * Zero npm dependencies — raw Node.js TLS/net sockets + IRC protocol.
 *
 * Env:
 *   IRC_SERVER          — IRC server hostname (default: irc.libera.chat)
 *   IRC_PORT            — IRC server port (default: 6697 for TLS, 6667 for plain)
 *   IRC_TLS             — "true" (default) or "false"
 *   IRC_NICK            — Bot nickname (default: nemoclaw)
 *   IRC_USER            — IRC username (default: nemoclaw)
 *   IRC_REALNAME        — Real name field (default: NemoClaw Agent Bridge)
 *   IRC_PASSWORD        — Server/NickServ password (optional)
 *   IRC_CHANNELS        — Comma-separated channels to join (default: #nemoclaw)
 *   IRC_ALLOWED_NICKS   — Comma-separated allowed nicks (optional, accepts all if unset)
 *   IRC_MENTION_ONLY    — "true" to require nick mention in channels (default: true)
 *   IRC_DM_POLICY       — "open" (default), "allowlist", or "disabled"
 *   NVIDIA_API_KEY      — For inference
 *   SANDBOX_NAME        — Sandbox name (default: nemoclaw)
 */

const crypto = require("crypto");
const net = require("net");
const tls = require("tls");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const { resolveOpenshell } = require("../dist/lib/resolve-openshell");
const { shellQuote, validateName } = require("../dist/lib/runner");

// ── Configuration ─────────────────────────────────────────────────

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const IRC_SERVER = process.env.IRC_SERVER || "irc.libera.chat";
const IRC_PORT = parseInt(process.env.IRC_PORT || (process.env.IRC_TLS === "false" ? "6667" : "6697"));
const IRC_TLS = process.env.IRC_TLS !== "false";
const IRC_NICK = process.env.IRC_NICK || "nemoclaw";
const IRC_USER = process.env.IRC_USER || "nemoclaw";
const IRC_REALNAME = process.env.IRC_REALNAME || "NemoClaw Agent Bridge";
const IRC_PASSWORD = process.env.IRC_PASSWORD || null;
const CHANNELS = (process.env.IRC_CHANNELS || "#nemoclaw").split(",").map((s) => s.trim());

const ALLOWED_NICKS = process.env.IRC_ALLOWED_NICKS
  ? process.env.IRC_ALLOWED_NICKS.split(",").map((s) => s.trim().toLowerCase())
  : null;
const MENTION_ONLY = process.env.IRC_MENTION_ONLY !== "false";
const DM_POLICY = process.env.IRC_DM_POLICY || "open";

const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { console.error(e.message); process.exit(1); }

if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

let currentNick = IRC_NICK;

// Per-user sessions
const sessions = new Map();
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;

// Queue to avoid flooding (IRC servers disconnect on excess flood)
const sendQueue = [];
let sendInterval = null;

// Track active agent requests to avoid duplicates
const activeRequests = new Set();

// ── IRC protocol ──────────────────────────────────────────────────

let socket = null;
let recvBuffer = "";

function connect() {
  recvBuffer = "";
  const options = { host: IRC_SERVER, port: IRC_PORT };

  if (IRC_TLS) {
    socket = tls.connect(options, () => {
      console.log(`[irc] TLS connected to ${IRC_SERVER}:${IRC_PORT}`);
      register();
    });
  } else {
    socket = net.createConnection(options, () => {
      console.log(`[irc] Connected to ${IRC_SERVER}:${IRC_PORT}`);
      register();
    });
  }

  socket.setEncoding("utf-8");

  socket.on("data", (data) => {
    recvBuffer += data;
    const lines = recvBuffer.split("\r\n");
    recvBuffer = lines.pop(); // incomplete line stays in buffer
    for (const line of lines) {
      if (line.length > 0) handleLine(line);
    }
  });

  socket.on("close", () => {
    console.log("[irc] Connection closed, reconnecting in 10s...");
    if (sendInterval) {
      clearInterval(sendInterval);
      sendInterval = null;
    }
    setTimeout(connect, 10000);
  });

  socket.on("error", (err) => {
    console.error("[irc] Socket error:", err.message);
  });

  // Flood control: send at most 1 line per 500ms
  if (sendInterval) clearInterval(sendInterval);
  sendInterval = setInterval(() => {
    if (sendQueue.length > 0 && socket && !socket.destroyed) {
      const line = sendQueue.shift();
      socket.write(line + "\r\n");
    }
  }, 500);
}

function raw(line) {
  sendQueue.push(line);
}

function rawImmediate(line) {
  if (socket && !socket.destroyed) {
    socket.write(line + "\r\n");
  }
}

function register() {
  currentNick = IRC_NICK;
  if (IRC_PASSWORD) {
    rawImmediate(`PASS ${IRC_PASSWORD}`);
  }
  rawImmediate(`NICK ${currentNick}`);
  rawImmediate(`USER ${IRC_USER} 0 * :${IRC_REALNAME}`);
}

// ── IRC message parsing (RFC 2812) ────────────────────────────────

function parseLine(line) {
  let prefix = null;
  let trailing = null;
  let rest = line;

  if (rest.startsWith(":")) {
    const idx = rest.indexOf(" ");
    prefix = rest.slice(1, idx);
    rest = rest.slice(idx + 1);
  }

  const trailIdx = rest.indexOf(" :");
  if (trailIdx !== -1) {
    trailing = rest.slice(trailIdx + 2);
    rest = rest.slice(0, trailIdx);
  }

  const parts = rest.split(" ");
  const command = parts[0];
  const params = parts.slice(1);
  if (trailing !== null) params.push(trailing);

  let nick = null, user = null, host = null;
  if (prefix) {
    const bangIdx = prefix.indexOf("!");
    const atIdx = prefix.indexOf("@");
    if (bangIdx !== -1 && atIdx !== -1) {
      nick = prefix.slice(0, bangIdx);
      user = prefix.slice(bangIdx + 1, atIdx);
      host = prefix.slice(atIdx + 1);
    } else {
      nick = prefix;
    }
  }

  return { prefix, nick, user, host, command, params };
}

// ── Message sending (chunked for IRC 512-byte limit) ─────────────

function sendMessage(target, text) {
  const maxLen = 400; // safe limit per chunk
  const lines = text.split("\n");

  for (const line of lines) {
    if (line.trim() === "") continue;
    for (let i = 0; i < line.length; i += maxLen) {
      raw(`PRIVMSG ${target} :${line.slice(i, i + maxLen)}`);
    }
  }
}

// ── Access control ───────────────────────────────────────────────

function isAllowed(nick) {
  if (!ALLOWED_NICKS) return true;
  return ALLOWED_NICKS.includes(nick.toLowerCase());
}

function isMentioned(text) {
  const lower = text.toLowerCase();
  return (
    lower.startsWith(currentNick.toLowerCase() + ":") ||
    lower.startsWith(currentNick.toLowerCase() + ",") ||
    lower.includes(currentNick.toLowerCase())
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMention(text) {
  const escapedNick = escapeRegExp(currentNick);
  const patterns = [
    new RegExp(`^${escapedNick}[,:;]?\\s*`, "i"),
    new RegExp(`@?${escapedNick}\\s*`, "gi"),
  ];
  let result = text;
  for (const pat of patterns) {
    result = result.replace(pat, "");
  }
  return result.trim();
}

// ── Session management ────────────────────────────────────────────

function getSessionKey(nick, target) {
  return `${nick}:${target}`;
}

function touchSession(sessionKey) {
  let session = sessions.get(sessionKey);
  if (!session) {
    session = {
      messages: [],
      lastActive: 0,
      remoteId: crypto.randomUUID(),
    };
  }
  session.lastActive = Date.now();
  sessions.set(sessionKey, session);
  return session;
}

function pruneStaleSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActive > SESSION_MAX_AGE_MS) {
      sessions.delete(id);
    }
  }
}

setInterval(pruneStaleSessions, 5 * 60 * 1000);

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });

    const confDir = fs.mkdtempSync("/tmp/nemoclaw-irc-ssh-");
    const confPath = `${confDir}/config`;
    fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    const cmd = `export NVIDIA_API_KEY=${shellQuote(API_KEY)} && nemoclaw-start openclaw agent --agent main --local -m ${shellQuote(message)} --session-id ${shellQuote("irc-" + safeSessionId)}`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 180000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { fs.unlinkSync(confPath); fs.rmdirSync(confDir); } catch { /* ignored */ }

      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();

      if (response) {
        resolve(response);
      } else if (code !== 0) {
        resolve(`Agent error (exit ${code}): ${stderr.trim().slice(0, 300)}`);
      } else {
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// ── Commands ─────────────────────────────────────────────────────

const COMMANDS = {
  help: (nick, target) => {
    sendMessage(target, `${nick}: Commands: !help, !status, !reset, !sessions. Or just talk to me.`);
  },
  status: (nick, target) => {
    let sandboxStatus;
    try {
      sandboxStatus = execFileSync(OPENSHELL, ["sandbox", "list"], {
        encoding: "utf-8", timeout: 5000,
      }).trim() || "unknown";
    } catch {
      sandboxStatus = "openshell not reachable";
    }
    sendMessage(target, `${nick}: Sandbox: ${sandboxStatus} | Sessions: ${sessions.size}`);
  },
  reset: (nick, target) => {
    const key = getSessionKey(nick, target);
    sessions.delete(key);
    sendMessage(target, `${nick}: Session cleared.`);
  },
  sessions: (nick, target) => {
    sendMessage(target, `${nick}: ${sessions.size} active session(s), pruning idle >30min.`);
  },
};

// ── IRC event handling ────────────────────────────────────────────

async function handlePrivmsg(parsed) {
  const { nick, params } = parsed;
  const target = params[0];
  const text = params[1] || "";
  const isChannel = target.startsWith("#") || target.startsWith("&");
  const replyTo = isChannel ? target : nick;

  // Access control
  if (!isAllowed(nick)) {
    console.log(`[irc] Blocked message from ${nick} (not in allowlist)`);
    return;
  }

  // DM policy
  if (!isChannel) {
    if (DM_POLICY === "disabled") return;
  }

  // Mention gating in channels
  if (isChannel && MENTION_ONLY && !isMentioned(text)) return;

  // Commands
  const stripped = stripMention(text).trim();
  if (stripped.startsWith("!")) {
    const cmd = stripped.slice(1).split(" ")[0].toLowerCase();
    if (COMMANDS[cmd]) {
      COMMANDS[cmd](nick, replyTo);
      return;
    }
  }

  const message = stripped || text;
  if (!message) return;

  const sessionKey = getSessionKey(nick, replyTo);

  // Deduplicate concurrent requests
  if (activeRequests.has(sessionKey)) {
    sendMessage(replyTo, `${nick}: Still processing your previous message...`);
    return;
  }

  console.log(`[${replyTo}] ${nick}: ${message.slice(0, 120)}`);

  const session = touchSession(sessionKey);
  session.messages.push({ role: "user", content: message });

  activeRequests.add(sessionKey);
  sendMessage(replyTo, `${nick}: Processing...`);

  try {
    const response = await runAgentInSandbox(message, session.remoteId);
    console.log(`[${replyTo}] agent: ${response.slice(0, 120)}...`);

    session.messages.push({ role: "assistant", content: response });

    const lines = response.split("\n");
    if (isChannel && lines.length > 0) {
      lines[0] = `${nick}: ${lines[0]}`;
    }
    sendMessage(replyTo, lines.join("\n"));
  } catch (err) {
    sendMessage(replyTo, `${nick}: Error: ${err.message}`);
  } finally {
    activeRequests.delete(sessionKey);
  }
}

function handleLine(line) {
  if (!line.includes("PASS")) {
    console.log(`<< ${line}`);
  }

  const parsed = parseLine(line);

  switch (parsed.command) {
    case "PING":
      rawImmediate(`PONG :${parsed.params[0] || ""}`);
      break;

    case "001": // RPL_WELCOME
      console.log(`[irc] Registered as ${currentNick}`);
      if (IRC_PASSWORD) {
        raw(`PRIVMSG NickServ :IDENTIFY ${IRC_PASSWORD}`);
      }
      for (const chan of CHANNELS) {
        raw(`JOIN ${chan}`);
        console.log(`[irc] Joining ${chan}`);
      }
      break;

    case "433": // ERR_NICKNAMEINUSE
      currentNick = currentNick + "_";
      console.log(`[irc] Nick in use, trying ${currentNick}`);
      rawImmediate(`NICK ${currentNick}`);
      break;

    case "JOIN":
      if (parsed.nick === currentNick) {
        console.log(`[irc] Joined ${parsed.params[0]}`);
      }
      break;

    case "KICK":
      if (parsed.params[1] === currentNick) {
        const chan = parsed.params[0];
        console.log(`[irc] Kicked from ${chan}, rejoining in 5s...`);
        setTimeout(() => raw(`JOIN ${chan}`), 5000);
      }
      break;

    case "PRIVMSG":
      void handlePrivmsg(parsed).catch((err) => {
        console.error("[irc] PRIVMSG handler failed:", err);
      });
      break;

    case "NOTICE":
      if (parsed.nick === "NickServ") {
        console.log(`[NickServ] ${parsed.params[1]}`);
      }
      break;

    case "ERROR":
      console.error(`[irc] Server error: ${parsed.params.join(" ")}`);
      break;
  }
}

// ── Main ──────────────────────────────────────────────────────────

function main() {
  const policyDesc = {
    dm: DM_POLICY,
    mention: MENTION_ONLY ? "required" : "any message",
    users: ALLOWED_NICKS ? `${ALLOWED_NICKS.length} allowed` : "all",
  };

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw IRC Bridge                                │");
  console.log("  │                                                     │");
  console.log(`  │  Server:    ${(IRC_SERVER + ":" + IRC_PORT + (IRC_TLS ? " (TLS)" : "") + "                        ").slice(0, 39)}│`);
  console.log(`  │  Nick:      ${(IRC_NICK + "                                  ").slice(0, 39)}│`);
  console.log(`  │  Channels:  ${(CHANNELS.join(", ") + "                          ").slice(0, 39)}│`);
  console.log("  │  Sandbox:   " + (SANDBOX + "                             ").slice(0, 39) + "│");
  console.log("  │                                                     │");
  console.log(`  │  DMs:       ${(policyDesc.dm + "                            ").slice(0, 39)}│`);
  console.log(`  │  Mentions:  ${(policyDesc.mention + "                       ").slice(0, 39)}│`);
  console.log(`  │  Users:     ${(policyDesc.users + "                         ").slice(0, 39)}│`);
  console.log("  │                                                     │");
  console.log("  │  !help — list commands in chat                      │");
  console.log("  │  Run 'openshell term' to monitor + approve egress.  │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  connect();
}

main();
