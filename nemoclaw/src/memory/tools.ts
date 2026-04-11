// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-callable tools for the typed memory provider.
 *
 * These tools are registered with OpenClaw's plugin system so the LLM agent
 * can call them autonomously during reasoning — no slash commands needed.
 */

import { Type } from "@sinclair/typebox";
import { TypedMemoryProvider } from "./typed-provider.js";
import { loadMemoryConfig } from "./config.js";
import type { MemoryType } from "./index.js";
import { isValidMemoryType, slugify } from "./index.js";

// ---------------------------------------------------------------------------
// Minimal type stubs matching OpenClaw's AgentTool shape.
// We use Record<string, unknown> for params since the full generic
// resolution requires the pi-agent-core runtime (not available at build).
// ---------------------------------------------------------------------------

interface TextContent {
  type: "text";
  text: string;
}

interface AgentToolResult {
  content: TextContent[];
  details: unknown;
}

interface AgentTool {
  name: string;
  description: string;
  label: string;
  parameters: unknown;
  ownerOnly?: boolean;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

// ---------------------------------------------------------------------------
// Tool: nemoclaw_memory_save
// ---------------------------------------------------------------------------

const MemorySaveParams = Type.Object({
  title: Type.String({ description: "Short title for the memory entry" }),
  type: Type.String({
    description: "Memory type: user, project, feedback, or reference",
  }),
  content: Type.String({ description: "The memory content to save" }),
  description: Type.Optional(Type.String({ description: "One-line description of this memory" })),
});

function createMemorySaveTool(workspaceDir: string): AgentTool {
  const provider = new TypedMemoryProvider(
    `${workspaceDir}/MEMORY.md`,
    `${workspaceDir}/memory/topics`,
  );

  return {
    name: "nemoclaw_memory_save",
    label: "Save memory",
    description:
      "Save a memory entry to the typed memory index. Use type 'user' for preferences, 'project' for project info, 'feedback' for corrections/guidance, 'reference' for facts/APIs.",
    parameters: MemorySaveParams,
    execute(_toolCallId, params) {
      const title = typeof params.title === "string" ? params.title : "";
      const rawType = typeof params.type === "string" ? params.type : "project";
      const content = typeof params.content === "string" ? params.content : "";
      const description = typeof params.description === "string" ? params.description : title;

      const type: MemoryType = isValidMemoryType(rawType) ? rawType : "project";
      const slug = slugify(title);
      if (!slug) {
        return Promise.resolve(
          textResult("Error: could not generate a valid slug from the title."),
        );
      }

      const now = new Date().toISOString();
      provider.save(
        slug,
        { name: title, description, type, created: now, updated: now },
        `\n${content}\n`,
      );

      return Promise.resolve(textResult(`Saved memory "${title}" (type: ${type}, slug: ${slug}).`));
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: nemoclaw_memory_read
// ---------------------------------------------------------------------------

const MemoryReadParams = Type.Object({
  slug: Type.String({ description: "The slug of the memory entry to read" }),
});

function createMemoryReadTool(workspaceDir: string): AgentTool {
  const provider = new TypedMemoryProvider(
    `${workspaceDir}/MEMORY.md`,
    `${workspaceDir}/memory/topics`,
  );

  return {
    name: "nemoclaw_memory_read",
    label: "Read memory",
    description:
      "Read the full content of a memory entry by its slug. Use this to load details from the memory index.",
    parameters: MemoryReadParams,
    execute(_toolCallId, params) {
      const slug = typeof params.slug === "string" ? params.slug : "";
      const topic = provider.load(slug);
      if (!topic) {
        return Promise.resolve(textResult(`Memory entry "${slug}" not found.`));
      }

      const lines = [
        `**${topic.frontmatter.name}** (${topic.frontmatter.type})`,
        `Description: ${topic.frontmatter.description}`,
        `Updated: ${topic.frontmatter.updated}`,
        "",
        topic.body.trim(),
      ];
      return Promise.resolve(textResult(lines.join("\n")));
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: nemoclaw_memory_search
// ---------------------------------------------------------------------------

const MemorySearchParams = Type.Object({
  query: Type.String({ description: "Search query to find memory entries" }),
});

function createMemorySearchTool(workspaceDir: string): AgentTool {
  const provider = new TypedMemoryProvider(
    `${workspaceDir}/MEMORY.md`,
    `${workspaceDir}/memory/topics`,
  );

  return {
    name: "nemoclaw_memory_search",
    label: "Search memory",
    description:
      "Search memory entries by keyword. Returns matching entries with their slugs. Use nemoclaw_memory_read to load full content.",
    parameters: MemorySearchParams,
    execute(_toolCallId, params) {
      const query = typeof params.query === "string" ? params.query : "";
      const results = provider.search(query);
      if (results.length === 0) {
        return Promise.resolve(textResult(`No memory entries found for "${query}".`));
      }

      const lines = [
        `Found ${String(results.length)} result(s) for "${query}":`,
        "",
        ...results.map(
          (e) => `- **${e.title}** (slug: ${e.slug}, type: ${e.type}, updated: ${e.updatedAt})`,
        ),
      ];
      return Promise.resolve(textResult(lines.join("\n")));
    },
  };
}

// ---------------------------------------------------------------------------
// Factory: create all memory tools for a session
// ---------------------------------------------------------------------------

export function createMemoryTools(workspaceDir: string): AgentTool[] | null {
  const config = loadMemoryConfig(workspaceDir);
  if (config.mode !== "typed-index") {
    return null;
  }

  return [
    createMemorySaveTool(workspaceDir),
    createMemoryReadTool(workspaceDir),
    createMemorySearchTool(workspaceDir),
  ];
}
