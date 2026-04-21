---
name: "nemoclaw-user-configure-security"
description: "Presents a risk framework for every configurable security control in NemoClaw. Use when evaluating security posture, reviewing sandbox security defaults, or assessing control trade-offs. Trigger keywords - nemoclaw security best practices, sandbox security controls risk framework, nemoclaw credential storage, credentials.json, api key security, openclaw security controls, nemoclaw security boundary, prompt injection, tool access control."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Security Best Practices: Controls, Risks, and Posture Profiles

## References

Load these files from `references/` when you need the full details:

- [references/best-practices.md](references/best-practices.md) — Presents a risk framework for every configurable security control in NemoClaw. Use when evaluating security posture, reviewing sandbox security defaults, or assessing control trade-offs
- [references/openclaw-controls.md](references/openclaw-controls.md) — Lists OpenClaw security controls that operate independently of NemoClaw, including prompt injection detection, tool access control, rate limiting, environment variable policy, audit framework, supply chain scanning, messaging access policy, context visibility, and safe regex. Use when reviewing the security boundary between NemoClaw and OpenClaw or assessing what NemoClaw does not cover
- [references/credential-storage.md](references/credential-storage.md) — Covers where NemoClaw stores provider credentials, the file permissions applied, and the trade-offs of plaintext local storage
