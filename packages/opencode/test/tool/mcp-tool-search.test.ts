import { describe, expect, test } from "bun:test"
import { createMcpToolSearch, searchMcpTools, type McpToolSearchEntry } from "../../src/tool/mcp-tool-search"

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
    expect(
      searchMcpTools(entries, { query: "search Google Drive documents", limit: 2 }).map((tool) => tool.name),
    ).toEqual(["drive_lookup"])
    expect(searchMcpTools(entries, { query: "invite people by email", limit: 2 }).map((tool) => tool.name)).toEqual([
      "calendar_create_event",
    ])
    expect(searchMcpTools(entries, { query: "slack send", limit: 2 }).map((tool) => tool.name)).toEqual([
      "slack_send_message",
    ])
  })

  test("returns loadable definitions and honors the default and explicit limits", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      name: `search_${index}`,
      description: `Search catalog ${index}`,
      parameters: { type: "object" },
    })) satisfies McpToolSearchEntry[]

    expect(searchMcpTools(many, { query: "search catalog" })).toHaveLength(8)
    expect(searchMcpTools(many, { query: "search catalog", limit: 3 })).toHaveLength(3)
    expect(searchMcpTools(entries, { query: "Google Drive" })[0]).toEqual({
      type: "function",
      name: "drive_lookup",
      description: "Search files and documents in Google Drive.",
      deferLoading: true,
      parameters: entries[0].parameters,
    })
  })

  test("rejects empty queries and non-positive limits", () => {
    expect(() => searchMcpTools(entries, { query: "  " })).toThrow("query must not be empty")
    expect(() => searchMcpTools(entries, { query: "drive", limit: 0 })).toThrow("limit must be greater than zero")
  })

  test("rebuilds cached search metadata when an entry changes", () => {
    expect(searchMcpTools(entries, { query: "spreadsheets" })).toEqual([])
    expect(
      searchMcpTools(
        entries.map((entry) =>
          entry.name === "drive_lookup"
            ? { ...entry, description: `${entry.description} Search spreadsheets.` }
            : entry,
        ),
        { query: "spreadsheets" },
      ).map((tool) => tool.name),
    ).toEqual(["drive_lookup"])
  })

  test("creates a client-executed OpenAI provider tool", async () => {
    const tool = createMcpToolSearch(entries)

    expect((tool as { type: string }).type).toBe("provider")
    expect((tool as { id: string }).id).toBe("openai.tool_search")
    expect((tool as unknown as { args: { execution: string } }).args.execution).toBe("client")
    expect(
      await tool.execute?.({ arguments: { query: "calendar event", limit: 1 }, call_id: "call_1" }, {} as never),
    ).toEqual({
      tools: [expect.objectContaining({ name: "calendar_create_event", deferLoading: true })],
    })
  })
})
