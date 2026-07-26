---
feature: mcp-tool-search
status: delivered
updated: 2026-07-26
branch: feature/mcp-tool-search
commits: c946f4c215aaf326036342a8c3dec6ad12d8772a..fc74c5391eb8e38306e043b8fac56abccd373575
---

# MCP Tool Search

## Report

**What was built** — MiMoCode now exposes a codebase-owned, client-executed `tool_search` for every resolved GPT model when MCP tools are available. Only MCP function definitions are marked for deferred OpenAI loading; built-in and custom tools remain direct, the existing MCP execution closures and permission/hook/metrics path remain intact, and non-GPT models are unchanged. GPT routes whose provider does not implement the OpenAI provider tool safely keep MCP tools directly exposed.

The search tool maintains a cached BM25 index over MCP names, descriptions, and recursive parameter metadata, returning exact loadable function definitions. Structured Tool Search outputs are persisted alongside display text and reconstructed as JSON so later OpenAI Responses requests can reproduce `tool_search_call` and `tool_search_output` history.

**Verification** — `bun test --timeout 30000 test/tool/mcp-tool-search.test.ts test/tool/gpt.test.ts test/session/message-v2.test.ts` passed 34 tests; the focused processor structured-output test passed 1 test; the OpenAI wire-shape/history test passed 1 test; the four GPT/non-GPT/no-MCP/gateway prompt tests passed. `bun typecheck` and `git diff --check` passed. A separate isolated MiMoCode reviewer found S2–S6 compliant and no critical or P1 defects. The unrelated `shell completion resumes queued loop callers` timeout reproduced on unchanged `main`; oxlint could not start because the pre-existing root config repeats `options.typeAware`.

**Journey log**

- The reference implementation clarified that this must be client-executed Tool Search with a local BM25 index, not OpenAI hosted search.
- Deferred tools must remain in the AI SDK tool map so discovered MCP calls still reach their original execute closures.
- Tool Search output must be retained as JSON; converting it to display text prevents Responses history reconstruction.
- OpenAI-compatible gateways drop the provider tool and ignore `deferLoading`, which preserves direct MCP availability as the intended fallback.
- Built-in actor review repeatedly failed with a runtime `UnknownError`; an isolated headless MiMoCode session completed the independent review instead.

## [S1] Problem

Every enabled MCP tool is currently sent to the model with its full input schema on every turn. Large MCP catalogs consume context, reduce prompt-cache stability, and make tool selection less focused even when the current request needs only a few MCP capabilities.

## [S2] GPT Eligibility And Provider Fallback

MCP Tool Search is enabled for every resolved GPT model, without a model-version restriction. Detection considers the configured model ID, resolved API model ID, and model family so aliases do not accidentally disable the feature. Claude and every non-GPT model remain unchanged.

The codebase supplies the OpenAI client-executed Tool Search provider tool for GPT requests regardless of the selected gateway. Native OpenAI Responses providers serialize and execute that protocol. Providers that do not understand the OpenAI provider tool may omit it and ignore the OpenAI deferred-loading option; on those routes MCP definitions remain directly exposed by the provider, preserving existing availability as the compatibility fallback.

## [S3] MCP-Only Deferred Exposure

For a GPT request with at least one available MCP tool, add the OpenAI client-executed `tool_search` provider tool and mark only MCP function tools with `providerOptions.openai.deferLoading = true`. Built-in, plugin, custom, skill, task, and all other non-MCP tools remain directly exposed and searchable MCP metadata never includes those tools. If no MCP tool is available, do not add `tool_search`.

Deferred MCP tools remain in the AI SDK tool map with their existing execute closures. Tool Search changes model visibility only; after discovery, execution continues through the existing MCP permission, plugin-hook, metrics, normalization, truncation, attachment, and client-call path.

## [S4] Local MCP Search

The codebase builds a cached BM25 index over the current MCP tool catalog. Each document includes the callable tool name, a space-expanded form of the name, the tool description, and recursively collected parameter names and descriptions from object properties, arrays, and union branches. Searches trim the query, reject an empty query, default to eight results, reject a non-positive limit, and return results in BM25 relevance order with a stable tool-name tie break.

Each result is an OpenAI loadable function definition containing the exact callable name, description, input parameters, and `deferLoading: true`. The cache is reused while the searchable metadata is unchanged and rebuilt when the MCP catalog or schema metadata changes. Search results are computed independently and are not persisted as global loaded state.

## [S5] Provider Tool History

Client-executed Tool Search calls and their JSON outputs must round-trip through session persistence without converting the loaded tool definitions to text or dropping them. Completed provider tools retain a display-safe textual output plus their original structured output. Model-message reconstruction uses the structured output and provider metadata so the OpenAI Responses provider can recreate `tool_search_call` and `tool_search_output` history on later turns.

Existing locally executed tool result persistence and UI output remain unchanged. Structured provider output is preserved across ordinary history reconstruction; if surrounding context is later compacted, the protocol data required to reconstruct a surviving provider tool call is not replaced with an invalid textual result.

## [S6] Testing Boundaries

Focused tests cover all-GPT eligibility, rejection of non-GPT models, BM25 matching over names, descriptions, and nested parameter metadata, query validation, cache invalidation, MCP-only deferred markers, absence of Tool Search without MCP tools, and lossless provider JSON result round-tripping. Request-shape coverage verifies client-executed `tool_search`, MCP `defer_loading`, and unchanged direct exposure for non-MCP tools.

## [S7] Out Of Scope

This change does not enable Tool Search for Claude or any non-GPT model, change MCP naming or execution, defer non-MCP tools, add namespace grouping or world-state summaries, guarantee that third-party gateways implement OpenAI's Tool Search protocol, or alter MCP configuration and connection lifecycle.

## Tasks

- [x] T1: Implement the cached MCP BM25 index and client Tool Search definition — acceptance: valid searches return ranked loadable MCP definitions, invalid inputs return actionable errors, and metadata changes rebuild the index (covers: S4)
- [x] T2: Add all-GPT Tool Search eligibility and MCP-only deferred tool assembly — acceptance: GPT requests with MCP tools contain one client Tool Search tool, only MCP functions carry deferred loading, non-GPT requests remain unchanged, and no empty search tool is exposed (covers: S2, S3; depends: T1)
- [x] T3: Preserve structured provider-tool outputs through persistence and model reconstruction — acceptance: a Tool Search JSON result survives storage and reconstructs as structured JSON rather than text (covers: S5)
- [x] T4: Add search, request-shape, fallback, and history regression tests and run package verification — acceptance: all S6 cases pass from `packages/opencode`, package typecheck succeeds, and the complete diff passes independent review (covers: S6; depends: T1, T2, T3)
