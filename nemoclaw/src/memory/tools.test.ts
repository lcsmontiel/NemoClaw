// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type fs from "node:fs";
import { createMemoryTools } from "./tools.js";

// ---------------------------------------------------------------------------
// In-memory filesystem mock
// ---------------------------------------------------------------------------

const store = new Map<string, string>();
const dirs = new Set<string>();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => store.has(p) || dirs.has(p),
    mkdirSync: (_p: string) => {
      dirs.add(_p);
    },
    readFileSync: (p: string) => {
      const content = store.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p: string, data: string) => {
      store.set(p, data);
    },
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const results: string[] = [];
      for (const key of store.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          results.push(key.slice(prefix.length));
        }
      }
      return results;
    },
    unlinkSync: (p: string) => {
      store.delete(p);
    },
  };
});

const WORKSPACE = "/test/workspace";
const CONFIG_PATH = `${WORKSPACE}/.nemoclaw-memory.json`;

describe("memory/tools", () => {
  beforeEach(() => {
    store.clear();
    dirs.clear();
  });

  // -----------------------------------------------------------------------
  // createMemoryTools
  // -----------------------------------------------------------------------

  describe("createMemoryTools()", () => {
    it("returns null when mode is default", () => {
      const tools = createMemoryTools(WORKSPACE);
      expect(tools).toBeNull();
    });

    it("returns null when config file does not exist", () => {
      const tools = createMemoryTools(WORKSPACE);
      expect(tools).toBeNull();
    });

    it("returns 3 tools when mode is typed-index", () => {
      store.set(CONFIG_PATH, JSON.stringify({ mode: "typed-index" }));
      const tools = createMemoryTools(WORKSPACE);
      expect(tools).not.toBeNull();
      expect(tools).toHaveLength(3);
      const names = tools?.map((t) => t.name) ?? [];
      expect(names).toContain("nemoclaw_memory_save");
      expect(names).toContain("nemoclaw_memory_read");
      expect(names).toContain("nemoclaw_memory_search");
    });
  });

  // -----------------------------------------------------------------------
  // nemoclaw_memory_save
  // -----------------------------------------------------------------------

  describe("nemoclaw_memory_save", () => {
    it("saves a memory entry and returns confirmation", async () => {
      store.set(CONFIG_PATH, JSON.stringify({ mode: "typed-index" }));
      const tools = createMemoryTools(WORKSPACE);
      if (!tools) throw new Error("expected tools");
      const saveTool = tools.find((t) => t.name === "nemoclaw_memory_save");
      if (!saveTool) throw new Error("expected save tool");

      const result = await saveTool.execute("call-1", {
        title: "Editor Preferences",
        type: "user",
        content: "VS Code with vim keybindings",
      });

      expect(result.content[0].text).toContain("Saved memory");
      expect(result.content[0].text).toContain("editor-preferences");
      expect(result.content[0].text).toContain("user");
    });

    it("defaults to project type for invalid type", async () => {
      store.set(CONFIG_PATH, JSON.stringify({ mode: "typed-index" }));
      const tools = createMemoryTools(WORKSPACE);
      if (!tools) throw new Error("expected tools");
      const saveTool = tools.find((t) => t.name === "nemoclaw_memory_save");
      if (!saveTool) throw new Error("expected save tool");

      const result = await saveTool.execute("call-1", {
        title: "Some note",
        type: "invalid-type",
        content: "Content here",
      });

      expect(result.content[0].text).toContain("project");
    });

    it("returns error for empty title", async () => {
      store.set(CONFIG_PATH, JSON.stringify({ mode: "typed-index" }));
      const tools = createMemoryTools(WORKSPACE);
      if (!tools) throw new Error("expected tools");
      const saveTool = tools.find((t) => t.name === "nemoclaw_memory_save");
      if (!saveTool) throw new Error("expected save tool");

      const result = await saveTool.execute("call-1", {
        title: "",
        type: "user",
        content: "Content",
      });

      expect(result.content[0].text).toContain("Error");
    });
  });

  // -----------------------------------------------------------------------
  // nemoclaw_memory_read
  // -----------------------------------------------------------------------

  describe("nemoclaw_memory_read", () => {
    it("reads an existing topic", async () => {
      store.set(CONFIG_PATH, JSON.stringify({ mode: "typed-index" }));
      const tools = createMemoryTools(WORKSPACE);
      if (!tools) throw new Error("expected tools");

      // First save a topic
      const saveTool = tools.find((t) => t.name === "nemoclaw_memory_save");
      if (!saveTool) throw new Error("expected save tool");
      await saveTool.execute("call-1", {
        title: "My Preference",
        type: "user",
        content: "I like dark mode",
      });

      // Now read it
      const readTool = tools.find((t) => t.name === "nemoclaw_memory_read");
      if (!readTool) throw new Error("expected read tool");
      const result = await readTool.execute("call-2", { slug: "my-preference" });

      expect(result.content[0].text).toContain("My Preference");
      expect(result.content[0].text).toContain("dark mode");
    });

    it("returns not found for missing slug", async () => {
      store.set(CONFIG_PATH, JSON.stringify({ mode: "typed-index" }));
      const tools = createMemoryTools(WORKSPACE);
      if (!tools) throw new Error("expected tools");
      const readTool = tools.find((t) => t.name === "nemoclaw_memory_read");
      if (!readTool) throw new Error("expected read tool");

      const result = await readTool.execute("call-1", { slug: "nonexistent" });
      expect(result.content[0].text).toContain("not found");
    });
  });

  // -----------------------------------------------------------------------
  // nemoclaw_memory_search
  // -----------------------------------------------------------------------

  describe("nemoclaw_memory_search", () => {
    it("finds matching entries", async () => {
      store.set(CONFIG_PATH, JSON.stringify({ mode: "typed-index" }));
      const tools = createMemoryTools(WORKSPACE);
      if (!tools) throw new Error("expected tools");

      const saveTool = tools.find((t) => t.name === "nemoclaw_memory_save");
      if (!saveTool) throw new Error("expected save tool");
      await saveTool.execute("call-1", {
        title: "Vim Setup",
        type: "user",
        content: "Use neovim with lua config",
      });

      const searchTool = tools.find((t) => t.name === "nemoclaw_memory_search");
      if (!searchTool) throw new Error("expected search tool");
      const result = await searchTool.execute("call-2", { query: "vim" });

      expect(result.content[0].text).toContain("vim-setup");
    });

    it("returns no results for unmatched query", async () => {
      store.set(CONFIG_PATH, JSON.stringify({ mode: "typed-index" }));
      const tools = createMemoryTools(WORKSPACE);
      if (!tools) throw new Error("expected tools");

      const searchTool = tools.find((t) => t.name === "nemoclaw_memory_search");
      if (!searchTool) throw new Error("expected search tool");
      const result = await searchTool.execute("call-1", { query: "xyznonexistent" });

      expect(result.content[0].text).toContain("No memory entries found");
    });
  });
});
