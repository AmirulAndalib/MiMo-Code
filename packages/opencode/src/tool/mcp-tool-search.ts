import type { JSONObject } from "@ai-sdk/provider"
import { Effect } from "effect"
import z from "zod"
import * as Tool from "./tool"

export const MCP_TOOL_SEARCH_ID = "mcp_tool_search"
export const MCP_TOOL_SEARCH_DEFAULT_LIMIT = 8
export const MCP_TOOL_SEARCH_MAX_LIMIT = 20
export const MCP_TOOL_SEARCH_MAX_LOADED = 32

const BM25_K1 = 1.2
const BM25_LENGTH_NORMALIZATION = 0.75

export type McpToolSearchEntry = {
  name: string
  description: string
  parameters: JSONObject
}

export type McpToolSearchCatalog = {
  key: string
  entries: McpToolSearchEntry[]
}

export type McpToolSearchMetadata = {
  catalogKey: string
  matchedTools: string[]
}

type SearchResult = {
  name: string
  description: string
  score: number
}

type SearchIndex = {
  key: string
  entries: McpToolSearchEntry[]
  documents: string[][]
  frequencies: Map<string, number>[]
  documentFrequency: Map<string, number>
  averageLength: number
}

let cached: SearchIndex | undefined

function tokenize(value: string) {
  return value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function schemaSearchText(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(schemaSearchText)
  if (!schema || typeof schema !== "object") return []

  const value = schema as Record<string, unknown>
  const properties =
    value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)
      ? Object.entries(value.properties as Record<string, unknown>).flatMap(([name, child]) => [
          name,
          ...schemaSearchText(child),
        ])
      : []

  return [
    ...(typeof value.description === "string" ? [value.description] : []),
    ...properties,
    ...schemaSearchText(value.items),
    ...schemaSearchText(value.anyOf),
    ...schemaSearchText(value.oneOf),
    ...schemaSearchText(value.allOf),
  ]
}

function index(entries: McpToolSearchEntry[]) {
  const key = JSON.stringify(entries)
  if (cached?.key === key) return cached

  const documents = entries.map((entry) =>
    tokenize(
      [entry.name, entry.name.replaceAll("_", " "), entry.description, ...schemaSearchText(entry.parameters)].join(" "),
    ),
  )
  const frequencies = documents.map((document) =>
    document.reduce((result, token) => result.set(token, (result.get(token) ?? 0) + 1), new Map<string, number>()),
  )
  cached = {
    key,
    entries,
    documents,
    frequencies,
    documentFrequency: frequencies.reduce((result, frequency) => {
      frequency.forEach((_, token) => result.set(token, (result.get(token) ?? 0) + 1))
      return result
    }, new Map<string, number>()),
    averageLength: documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1,
  }
  return cached
}

export function createMcpToolSearchCatalog(entries: McpToolSearchEntry[]): McpToolSearchCatalog {
  return {
    key: new Bun.CryptoHasher("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
  }
}

export function searchMcpTools(entries: McpToolSearchEntry[], input: { query: string; limit?: number }): SearchResult[] {
  const query = input.query.trim()
  if (!query) throw new Error("query must not be empty")

  const limit = input.limit ?? MCP_TOOL_SEARCH_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > MCP_TOOL_SEARCH_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MCP_TOOL_SEARCH_MAX_LIMIT}`)
  }
  if (entries.length === 0) return []

  const search = index(entries)
  const queryTokens = [...new Set(tokenize(query))]
  return search.documents
    .map((document, documentIndex) => ({
      documentIndex,
      score: queryTokens.reduce((score, token) => {
        const frequency = search.frequencies[documentIndex].get(token) ?? 0
        if (frequency === 0) return score
        const documentFrequency = search.documentFrequency.get(token) ?? 0
        const inverseDocumentFrequency = Math.log(
          1 + (search.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
        )
        return (
          score +
          inverseDocumentFrequency *
            ((frequency * (BM25_K1 + 1)) /
              (frequency +
                BM25_K1 *
                  (1 -
                    BM25_LENGTH_NORMALIZATION +
                    BM25_LENGTH_NORMALIZATION * (document.length / search.averageLength))))
        )
      }, 0),
    }))
    .filter((result) => result.score > 0)
    .toSorted(
      (a, b) =>
        b.score - a.score || search.entries[a.documentIndex].name.localeCompare(search.entries[b.documentIndex].name),
    )
    .slice(0, limit)
    .map((result) => ({
      name: search.entries[result.documentIndex].name,
      description: search.entries[result.documentIndex].description,
      score: result.score,
    }))
}

function catalog(input: unknown): McpToolSearchCatalog | undefined {
  if (!input || typeof input !== "object") return
  if (!("key" in input) || typeof input.key !== "string") return
  if (!("entries" in input) || !Array.isArray(input.entries)) return
  return input as McpToolSearchCatalog
}

const Parameters = z.object({
  query: z.string().describe("Search query describing the MCP capability needed for the current task."),
  limit: z.number().int().min(1).max(MCP_TOOL_SEARCH_MAX_LIMIT).optional(),
})

export const McpToolSearchTool = Tool.define(
  MCP_TOOL_SEARCH_ID,
  Effect.succeed({
    description: [
      "Search locally available MCP tools and load only the matching capabilities for the current user request.",
      "Use this before attempting an MCP operation. Matching tools become callable on the next step.",
    ].join("\n"),
    parameters: Parameters,
    execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context<McpToolSearchMetadata>) =>
      Effect.sync(() => {
        const available = catalog(ctx.extra?.mcpToolSearch)
        if (!available || available.entries.length === 0) {
          return {
            title: "No MCP tools available",
            output: JSON.stringify({ status: "no_match", results: [] }, null, 2),
            metadata: { catalogKey: available?.key ?? "", matchedTools: [] },
          }
        }

        const results = searchMcpTools(available.entries, params)
        return {
          title: results.length > 0 ? `Loaded ${results.length} MCP tool${results.length === 1 ? "" : "s"}` : "No matching MCP tools",
          output: JSON.stringify({ status: results.length > 0 ? "matched" : "no_match", results }, null, 2),
          metadata: { catalogKey: available.key, matchedTools: results.map((result) => result.name) },
        }
      }),
  }),
)
