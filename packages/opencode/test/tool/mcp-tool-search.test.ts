import { describe, expect, test } from "bun:test"
import {
  createMcpToolSearchCatalog,
  MCP_TOOL_SEARCH_DEFAULT_LIMIT,
  MCP_TOOL_SEARCH_MAX_LIMIT,
  searchMcpTools,
  type McpToolSearchEntry,
} from "../../src/tool/mcp-tool-search"

const entries: McpToolSearchEntry[] = [
  {
    name: "drive_lookup",
    description: "Search files and documents in Google Drive.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words contained in the document" },
        filters: {
          type: "object",
          properties: {
            file_type: { type: "string", description: "Limit results to PDFs or documents" },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "slack_send_message",
    description: "Send a message to a Slack channel.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string" },
        message: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_create_event",
    description: "Create a calendar event.",
    parameters: {
      type: "object",
      properties: {
        attendees: {
          type: "array",
          items: { type: "string", description: "Email addresses of invited people" },
        },
      },
      additionalProperties: false,
    },
  },
]

describe("MCP Tool Search", () => {
  test("ranks names, descriptions, and nested schema metadata with BM25", () => {
    expect(searchMcpTools(entries, { query: "search Google Drive documents" }).map((tool) => tool.name)).toEqual([
      "drive_lookup",
    ])
    expect(searchMcpTools(entries, { query: "invite people by email" }).map((tool) => tool.name)).toEqual([
      "calendar_create_event",
    ])
    expect(searchMcpTools(entries, { query: "slack send" }).map((tool) => tool.name)).toEqual([
      "slack_send_message",
    ])
  })

  test("returns only model-safe result metadata and honors limits", () => {
    const many = Array.from({ length: MCP_TOOL_SEARCH_DEFAULT_LIMIT + 2 }, (_, index) => ({
      name: `search_${index}`,
      description: `Search catalog ${index}`,
      parameters: { type: "object" },
    })) satisfies McpToolSearchEntry[]

    expect(searchMcpTools(many, { query: "search catalog" })).toHaveLength(MCP_TOOL_SEARCH_DEFAULT_LIMIT)
    expect(searchMcpTools(many, { query: "search catalog", limit: 3 })).toHaveLength(3)
    expect(searchMcpTools(entries, { query: "Google Drive" })[0]).toEqual({
      name: "drive_lookup",
      description: "Search files and documents in Google Drive.",
      score: expect.any(Number),
    })
    expect(searchMcpTools(entries, { query: "Google Drive" })[0]).not.toHaveProperty("parameters")
  })

  test("rejects invalid queries and limits", () => {
    expect(() => searchMcpTools(entries, { query: "  " })).toThrow("query must not be empty")
    expect(() => searchMcpTools(entries, { query: "drive", limit: 0 })).toThrow("limit must be an integer")
    expect(() => searchMcpTools(entries, { query: "drive", limit: 1.5 })).toThrow("limit must be an integer")
    expect(() => searchMcpTools(entries, { query: "drive", limit: MCP_TOOL_SEARCH_MAX_LIMIT + 1 })).toThrow(
      "limit must be an integer",
    )
  })

  test("rebuilds cached metadata and changes catalog fingerprints", () => {
    const catalog = createMcpToolSearchCatalog(entries)
    const changed = entries.map((entry) =>
      entry.name === "drive_lookup" ? { ...entry, description: `${entry.description} Search spreadsheets.` } : entry,
    )

    expect(searchMcpTools(entries, { query: "spreadsheets" })).toEqual([])
    expect(searchMcpTools(changed, { query: "spreadsheets" }).map((tool) => tool.name)).toEqual(["drive_lookup"])
    expect(createMcpToolSearchCatalog(changed).key).not.toBe(catalog.key)
    expect(catalog.key).toHaveLength(64)
    expect(catalog.key).not.toContain("drive_lookup")
  })
})
