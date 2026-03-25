// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const assert = require("assert");
const { loadAllowList, OVERRIDES_PATH } = require("../bin/lib/config-set");

describe("config-set", () => {
  describe("loadAllowList", () => {
    it("returns a non-empty set of mutable field paths", () => {
      const allowList = loadAllowList();
      assert.ok(allowList.size > 0, "allow-list should not be empty");
    });

    it("includes agents.defaults.model.primary", () => {
      const allowList = loadAllowList();
      assert.ok(allowList.has("agents.defaults.model.primary"));
    });

    it("includes channels.defaults.configWrites", () => {
      const allowList = loadAllowList();
      assert.ok(allowList.has("channels.defaults.configWrites"));
    });

    it("does NOT include gateway paths", () => {
      const allowList = loadAllowList();
      for (const key of allowList) {
        assert.ok(!key.startsWith("gateway."), `allow-list must not contain gateway.* keys, found: ${key}`);
      }
    });
  });

  describe("OVERRIDES_PATH", () => {
    it("points to writable partition", () => {
      assert.ok(OVERRIDES_PATH.startsWith("/sandbox/.openclaw-data/"));
    });

    it("is a json5 file", () => {
      assert.ok(OVERRIDES_PATH.endsWith(".json5"));
    });
  });
});
