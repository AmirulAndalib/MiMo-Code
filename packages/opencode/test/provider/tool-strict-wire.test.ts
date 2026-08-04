import { describe, expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText, jsonSchema, tool } from "ai"
import { ProviderTransform } from "../../src/provider"

// WIRE-LEVEL proof that function tools ship with an explicit `strict: false` to
// the OpenAI Responses API.
//
// The Responses API treats a function tool that OMITS `strict` as strict, and
// `@ai-sdk/openai` only emits the field when the tool sets it
// (`...tool.strict != null ? { strict: tool.strict } : {}`). Our schemas are not
// strict-compatible — optional parameters stay out of `required` and objects do
// not all carry `additionalProperties: false` — so the Codex backend auto-patched
// them, failed to compile the decoding grammar, and returned `server_error`
// MID-STREAM after the 200 was already committed (the answer stopped
// half-written). Explicit `strict: false` is the fix.
//
// Asserting on `ProviderTransform.tools`' return value alone is two layers short
// of the wire: `ai`'s `prepareToolsAndToolChoice` has the same
// `tool.strict != null` guard, so a field that fails to survive it never reaches
// the provider. These tests capture the real outbound HTTP body instead.

function model(npm: string, overrides: Partial<any> = {}) {
  return {
    id: `test/${npm}`,
    providerID: "test",
    api: { id: "gpt-5.1-codex", url: "https://api.openai.com/v1", npm },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
    limit: { context: 200_000, output: 64_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
    ...overrides,
  } as any
}

// `ProviderTransform.tools` mutates the record in place, so every test needs a
// fresh set. Mirrors the real shape that broke: `timeout` is optional (absent
// from `required`) and no object declares `additionalProperties: false`.
const toolset = () => ({
  bash: tool({
    description: "Run a shell command",
    inputSchema: jsonSchema<any>({
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout: { type: "number", description: "Timeout in ms" },
      },
      required: ["command"],
    }),
    execute: async () => "ok",
  }),
  read: tool({
    description: "Read a file",
    inputSchema: jsonSchema<any>({
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "number" } },
      required: ["path"],
    }),
    execute: async () => "ok",
  }),
})

const responsesReply = {
  id: "resp_1",
  object: "response",
  created_at: 1_755_000_000,
  status: "completed",
  model: "gpt-5.1-codex",
  output: [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  incomplete_details: null,
}

const anthropicReply = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
}

// Runs the tool set through the real `ai` core + real provider and returns the
// parsed outbound HTTP body.
async function outbound(tools: Record<string, any>, reply: unknown, build: (fetch: any) => any) {
  let captured: any
  const languageModel = build((async (_url: any, init: any) => {
    captured = JSON.parse(init.body as string)
    return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } })
  }) as any)
  // The reply is a text answer, so the tool loop never runs; a validation
  // mismatch on the stub is irrelevant because the body is already captured.
  await generateText({ model: languageModel, prompt: "hi", tools }).catch(() => {})
  return captured
}

const openaiResponses = (tools: Record<string, any>) =>
  outbound(tools, responsesReply, (fetch) =>
    createOpenAI({ apiKey: "test-key", fetch }).responses("gpt-5.1-codex"),
  )

const anthropicMessages = (tools: Record<string, any>) =>
  outbound(tools, anthropicReply, (fetch) => createAnthropic({ apiKey: "test-key", fetch })("claude-sonnet-4"))

describe("function tools reach the OpenAI Responses API with an explicit strict: false", () => {
  test("CONTROL: untransformed tools omit `strict` entirely (the defect)", async () => {
    const body = await openaiResponses(toolset())
    expect(body.tools).toHaveLength(2)
    // Proof of the mechanism, and proof this test would catch a regression:
    // omitting the field is what made the backend treat these as strict.
    for (const entry of body.tools) expect(entry).not.toHaveProperty("strict")
  })

  test("every tool ships `strict: false` after ProviderTransform.tools", async () => {
    const body = await openaiResponses(ProviderTransform.tools(toolset(), model("@ai-sdk/openai")))
    expect(body.tools.map((entry: any) => [entry.name, entry.strict])).toEqual([
      ["bash", false],
      ["read", false],
    ])
  })

  test("the schemas themselves are untouched — only `strict` is added", async () => {
    const before = await openaiResponses(toolset())
    const after = await openaiResponses(ProviderTransform.tools(toolset(), model("@ai-sdk/openai")))
    expect(after.tools.map((entry: any) => entry.parameters)).toEqual(
      before.tools.map((entry: any) => entry.parameters),
    )
    // The shape that the backend auto-patched survives verbatim: `timeout`
    // stays optional and no `additionalProperties: false` is invented.
    expect(after.tools[0].parameters.required).toEqual(["command"])
    expect(after.tools[0].parameters).not.toHaveProperty("additionalProperties")
  })

  test("@ai-sdk/azure gets the same treatment — it builds OpenAI's responses model", () => {
    const tools = ProviderTransform.tools(toolset(), model("@ai-sdk/azure"))
    expect(Object.values(tools).map((entry: any) => entry.strict)).toEqual([false, false])
  })

  test("an explicit per-tool `strict` is preserved, not overwritten", async () => {
    const tools = toolset()
    ;(tools.bash as any).strict = true
    const body = await openaiResponses(ProviderTransform.tools(tools, model("@ai-sdk/openai")))
    expect(body.tools.map((entry: any) => [entry.name, entry.strict])).toEqual([
      ["bash", true],
      ["read", false],
    ])
  })
})

describe("non-OpenAI SDKs are left alone", () => {
  // @ai-sdk/anthropic emits an "unsupported feature" warning for ANY non-null
  // `strict`, so defaulting it there would spam warnings on every request.
  test("anthropic tools keep `strict` unset and nothing reaches the wire", async () => {
    const tools = ProviderTransform.tools(toolset(), model("@ai-sdk/anthropic"))
    for (const entry of Object.values(tools)) expect(entry).not.toHaveProperty("strict")

    const body = await anthropicMessages(tools)
    expect(body.tools).toHaveLength(2)
    for (const entry of body.tools) expect(entry).not.toHaveProperty("strict")
  })

  test("anthropic requests emit no strict-mode warning", async () => {
    const warnings = await generateText({
      model: createAnthropic({
        apiKey: "test-key",
        fetch: (async () =>
          new Response(JSON.stringify(anthropicReply), {
            headers: { "content-type": "application/json" },
          })) as any,
      })("claude-sonnet-4"),
      prompt: "hi",
      tools: ProviderTransform.tools(toolset(), model("@ai-sdk/anthropic")),
    }).then((result) => result.warnings)
    expect(warnings?.filter((warning: any) => warning.feature === "strict")).toEqual([])
  })

  test("openai-compatible proxies are untouched", () => {
    const tools = ProviderTransform.tools(toolset(), model("@ai-sdk/openai-compatible"))
    for (const entry of Object.values(tools)) expect(entry).not.toHaveProperty("strict")
  })
})
