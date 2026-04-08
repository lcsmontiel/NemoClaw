#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
Generate Hermes config.yaml and .env from NemoClaw build-arg env vars.

Called at Docker image build time. Reads NEMOCLAW_* env vars and writes:
  ~/.hermes/config.yaml  — Hermes configuration (immutable at runtime)
  ~/.hermes/.env         — Messaging token placeholders (immutable at runtime)

Only sets what's required for Hermes to run inside OpenShell:
  - Model and inference endpoint (custom provider pointing at inference.local)
  - API server on internal port (socat forwards to public port)
  - Messaging platform tokens (if configured during onboard)
Everything else uses Hermes defaults.
"""

import base64
import json
import os

import yaml


def main():
    model = os.environ["NEMOCLAW_MODEL"]
    base_url = os.environ["NEMOCLAW_INFERENCE_BASE_URL"]

    msg_channels = json.loads(
        base64.b64decode(
            os.environ.get("NEMOCLAW_MESSAGING_CHANNELS_B64", "W10=") or "W10="
        ).decode("utf-8")
    )
    allowed_ids = json.loads(
        base64.b64decode(
            os.environ.get("NEMOCLAW_MESSAGING_ALLOWED_IDS_B64", "e30=") or "e30="
        ).decode("utf-8")
    )

    # Only what's needed: model routing and API server port.
    # Everything else (memory, skills, display, agent config) uses Hermes defaults.
    config = {
        "_config_version": 12,
        "model": {
            "default": model,
            "provider": "custom",
            "base_url": base_url,
        },
    }

    # Messaging platforms (if configured during onboard)
    token_env = {
        "telegram": "TELEGRAM_BOT_TOKEN",
        "discord": "DISCORD_BOT_TOKEN",
        "slack": "SLACK_BOT_TOKEN",
    }
    platforms_config = {}
    for ch in msg_channels:
        if ch in token_env:
            p_cfg = {
                "enabled": True,
                "token": f"openshell:resolve:env:{token_env[ch]}",
            }
            if ch in allowed_ids and allowed_ids[ch]:
                p_cfg["allowed_users"] = ",".join(
                    str(uid) for uid in allowed_ids[ch]
                )
            platforms_config[ch] = p_cfg

    if platforms_config:
        config["platforms"] = platforms_config

    # API server — internal port only.
    # Hermes binds to 127.0.0.1 regardless of config (upstream bug).
    # socat in start.sh forwards 0.0.0.0:8642 -> 127.0.0.1:18642.
    config.setdefault("platforms", {})["api_server"] = {
        "enabled": True,
        "extra": {
            "port": 18642,
            "host": "127.0.0.1",
        },
    }

    # Write config.yaml
    config_path = os.path.expanduser("~/.hermes/config.yaml")
    with open(config_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)
    os.chmod(config_path, 0o600)

    # Write .env — only messaging token placeholders
    env_lines = []
    for ch in msg_channels:
        if ch in token_env:
            env_lines.append(
                f"{token_env[ch]}=openshell:resolve:env:{token_env[ch]}"
            )

    env_path = os.path.expanduser("~/.hermes/.env")
    with open(env_path, "w") as f:
        f.write("\n".join(env_lines) + "\n" if env_lines else "")
    os.chmod(env_path, 0o600)

    print(f"[config] Wrote {config_path} (model={model}, provider=custom)")
    print(f"[config] Wrote {env_path} ({len(env_lines)} entries)")


if __name__ == "__main__":
    main()
