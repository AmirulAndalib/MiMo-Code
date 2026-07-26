---
feature: mcp-tool-search
status: in-progress
updated: 2026-07-26
branch: feature/mcp-tool-search
commits: c946f4c215aaf326036342a8c3dec6ad12d8772a..working-tree
---

# MCP Tool Skillization

## [S1] Problem

Sending every MCP function definition to the model exposes the complete catalog and consumes context before the task needs any MCP capability. OpenAI `defer_loading` does not solve this for individual functions because their names and descriptions remain visible, and the provider-specific protocol cannot generalize to Claude, Gemini, DeepSeek, MiMo, or compatibility gateways.

## [S2] Private Catalog And Generic Discovery

MiMoCode keeps every MCP name, description, transformed schema, and execute closure in a local registry. None of that MCP metadata is model-visible on the first request. When at least one effective MCP tool exists and the selected model supports function calling, the request exposes one ordinary function named `mcp_tool_search`.

`mcp_tool_search` uses a cached local BM25 index over callable names, descriptions, and recursive parameter names/descriptions. It returns only matched names, descriptions, and scores in its visible output; schemas remain private until activation. The literal name `tool_search` is intentionally avoided because OpenAI Responses adapters reserve it for the native provider protocol.

## [S3] Request-Scoped Loading

A successful search persists a catalog fingerprint and validated matched callable names in ordinary tool-result metadata. On the next existing Session outer-loop step, MiMoCode scans only completed searches parented to the current user message, unions valid matches, and exposes those MCP definitions through the AI SDK `activeTools` subset.

Loaded tools accumulate across searches for the current user request, up to a bounded total. A new user message starts with all MCP functions hidden again. A catalog change invalidates earlier matches. Model-visible output is never trusted as activation state.

## [S4] Execution Safety

All MCP executors remain in the full local tool map so existing permission checks, actor whitelists, plugin hooks, metrics, result normalization, truncation, attachments, cancellation, and MCP client dispatch are preserved. Before any side effect, the MCP wrapper rejects a call not loaded for the current request and instructs the model to use `mcp_tool_search`.

This guard covers hallucinated calls, stale history, repair mistakes, Max Mode replay, and same-step parallel search plus MCP calls. Search matches become callable only on the next outer-loop step. Local tools win on callable-name collisions, and conflicting MCP entries are not advertised.

## [S5] Provider And ToolScript Behavior

The mechanism uses an ordinary function tool and applies to every resolved model with `capabilities.toolcall = true`; it does not depend on model-family detection, OpenAI provider tools, or `defer_loading`. Models without function calling receive neither MCP discovery nor MCP definitions.

The GPT ToolScript/`exec` surface no longer embeds or dispatches MCP tools. This prevents ToolScript descriptions and sandbox declarations from leaking the private catalog or bypassing request-scoped activation. Loaded MCP capabilities are invoked through their ordinary direct tool definitions.

## [S6] Testing Boundaries

Focused coverage must prove that initial GPT and non-GPT requests contain `mcp_tool_search` but no MCP name, description, or schema; only search matches appear on the next request; unmatched tools remain hidden; multiple searches accumulate; new user messages reset loading; non-tool-call models omit discovery; inactive calls fail recoverably; and ordinary MCP success/error normalization remains unchanged.

Tests also cover BM25 ranking and cache invalidation, active tool wire serialization, ToolScript isolation, reserved search-tool collisions, limits, catalog fingerprints, and package type safety.

## [S7] Out Of Scope

This change does not add semantic embeddings, persist loaded tools across user requests, expose MCP server summaries, change MCP connection lifecycle, redesign MCP naming, or make non-function-calling models capable of tool use.

## Report

Pending final verification and independent review.

## Tasks

- [x] T1: Replace provider-native Tool Search with ordinary `mcp_tool_search` and cached local BM25 discovery.
- [x] T2: Separate registered executors from model-visible `activeTools` and activate only request-scoped matches.
- [x] T3: Preserve MCP execution safety while removing ToolScript catalog leakage and inactive-call bypasses.
- [ ] T4: Complete focused/broad verification, independent review, and delivery report.
