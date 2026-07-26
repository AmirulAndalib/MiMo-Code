import { openai } from "@ai-sdk/openai"
import type { JSONObject } from "@ai-sdk/provider"

const DEFAULT_LIMIT = 8
const BM25_K1 = 1.2
const BM25_LENGTH_NORMALIZATION = 0.75

export type McpToolSearchEntry = {
  name: string
  description: string
  parameters: JSONObject
}

type LoadableMcpTool = {
  type: "function"
  name: string
  description: string
  deferLoading: true
  parameters: JSONObject
}

type SearchIndex = {
  key: string
  entries: LoadableMcpTool[]
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
    documents,
    frequencies,
    documentFrequency: frequencies.reduce((result, frequency) => {
      frequency.forEach((_, token) => result.set(token, (result.get(token) ?? 0) + 1))
      return result
    }, new Map<string, number>()),
    averageLength: documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1,
    entries: entries.map((entry) => ({
      type: "function",
      name: entry.name,
      description: entry.description,
      deferLoading: true,
      parameters: entry.parameters,
    })),
  }
  return cached
}

export function searchMcpTools(entries: McpToolSearchEntry[], input: { query: string; limit?: number }) {
  const query = input.query.trim()
  if (!query) throw new Error("query must not be empty")

  const limit = input.limit ?? DEFAULT_LIMIT
  if (limit <= 0) throw new Error("limit must be greater than zero")
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
    .slice(0, Math.floor(limit))
    .map((result) => search.entries[result.documentIndex])
}

export function createMcpToolSearch(entries: McpToolSearchEntry[]) {
  return openai.tools.toolSearch({
    execution: "client",
    description: [
      "# Tool discovery",
      "",
      "Searches over deferred MCP tool metadata with BM25 and exposes matching tools for the next model call.",
      "Some MCP tools are not provided upfront; use `tool_search` to discover the tools needed for the task.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for deferred MCP tools." },
        limit: { type: "number", description: `Maximum number of tools to return. Defaults to ${DEFAULT_LIMIT}.` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const args =
        typeof input.arguments === "string"
          ? JSON.parse(input.arguments)
          : (input.arguments as { query?: unknown; limit?: unknown } | undefined)
      if (!args || typeof args.query !== "string") throw new Error("query must be a string")
      if (args.limit !== undefined && typeof args.limit !== "number") throw new Error("limit must be a number")
      return { tools: searchMcpTools(entries, { query: args.query, limit: args.limit }) }
    },
  })
}
