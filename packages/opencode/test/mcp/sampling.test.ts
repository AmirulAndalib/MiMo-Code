import { test, expect, describe } from "bun:test"
import { McpSampling } from "../../src/mcp/sampling"
import { ModelCapability } from "../../src/provider/capability-registry"
import { wav } from "./wav-fixture"


function textRequest(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }], maxTokens: 100 }
}

describe("decodedByteLength", () => {
  test("matches Buffer for real payloads including both padding forms", () => {
    for (const raw of ["a", "ab", "abc", "abcd", "hello world", "\u0000\u0001\u0002"]) {
      const b64 = Buffer.from(raw).toString("base64")
      expect(McpSampling.decodedByteLength(b64)).toBe(Buffer.byteLength(raw))
    }
  })

  test("rejects wrong length, illegal characters and interior padding", () => {
    expect(McpSampling.decodedByteLength("abc")).toBeUndefined()
    expect(McpSampling.decodedByteLength("!!!!")).toBeUndefined()
    expect(McpSampling.decodedByteLength("ab=cQUJD")).toBeUndefined()
    expect(McpSampling.decodedByteLength("AA AA")).toBeUndefined()
  })

  test("sizes a 30s 16kHz mono WAV without decoding it", () => {
    const buffer = wav(30)
    expect(buffer.length).toBe(44 + 30 * 16_000 * 2)
    expect(McpSampling.decodedByteLength(buffer.toString("base64"))).toBe(buffer.length)
  })
})

describe("normalizeMime", () => {
  test("lowercases, strips parameters and enforces the modality prefix", () => {
    expect(McpSampling.normalizeMime("Audio/WAV", "audio")).toBe("audio/wav")
    expect(McpSampling.normalizeMime("audio/wav; codecs=1", "audio")).toBe("audio/wav")
    expect(McpSampling.normalizeMime("image/png", "audio")).toBeUndefined()
    expect(McpSampling.normalizeMime("not-a-mime", "audio")).toBeUndefined()
    expect(McpSampling.normalizeMime("audio/", "audio")).toBeUndefined()
  })
})

describe("convertMessages", () => {
  test("text becomes a text part and a text requirement", () => {
    const result = McpSampling.convertMessages(textRequest("hello"))
    if (result instanceof McpSampling.SamplingError) throw result
    expect(result.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }])
    expect(result.requirements).toEqual([{ modality: "text", bytes: 5 }])
    expect(result.summary.contentTypes).toEqual(["text"])
  })

  test("image becomes a file part carrying raw bytes, never text", () => {
    const data = Buffer.from("fakepng").toString("base64")
    const result = McpSampling.convertMessages({
      messages: [{ role: "user", content: [{ type: "image", data, mimeType: "image/png" }] }],
      maxTokens: 100,
    })
    if (result instanceof McpSampling.SamplingError) throw result
    expect(result.messages[0].content).toEqual([{ type: "file", data, mediaType: "image/png" }])
    expect(result.requirements).toEqual([{ modality: "image", mimeType: "image/png", bytes: 7 }])
  })

  test("audio becomes a file part with its media type, and is summarised for the prompt", () => {
    const buffer = wav(30)
    const data = buffer.toString("base64")
    const result = McpSampling.convertMessages({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this." },
            { type: "audio", data, mimeType: "audio/wav" },
          ],
        },
      ],
      maxTokens: 2048,
      systemPrompt: "You are a transcription engine.",
    })
    if (result instanceof McpSampling.SamplingError) throw result
    // The audio rides as real bytes with a media type — NOT stringified into text.
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "Transcribe this." },
      { type: "file", data, mediaType: "audio/wav" },
    ])
    expect(result.requirements).toContainEqual({
      modality: "audio",
      mimeType: "audio/wav",
      bytes: buffer.length,
    })
    expect([...result.summary.contentTypes].sort()).toEqual(["audio", "text"])
    expect(result.summary.audio).toEqual([{ mimeType: "audio/wav", bytes: buffer.length }])
    expect(result.summary.systemPrompt).toBe("You are a transcription engine.")
    expect(result.summary.textPrompt).toBe("Transcribe this.")
  })

  test("a bare (non-array) content block is accepted per the schema", () => {
    const result = McpSampling.convertMessages(textRequest("bare"))
    if (result instanceof McpSampling.SamplingError) throw result
    expect(result.messages[0].content).toEqual([{ type: "text", text: "bare" }])
  })

  test("illegal base64 is rejected with InvalidParams", () => {
    const result = McpSampling.convertMessages({
      messages: [{ role: "user", content: [{ type: "audio", data: "not!!base64", mimeType: "audio/wav" }] }],
      maxTokens: 10,
    })
    expect(result).toBeInstanceOf(McpSampling.SamplingError)
    if (!(result instanceof McpSampling.SamplingError)) throw new Error("unreachable")
    expect(result.code).toBe(-32602)
    expect(result.message).toMatch(/not valid base64/)
  })

  test("empty media payloads are rejected", () => {
    const result = McpSampling.convertMessages({
      messages: [{ role: "user", content: [{ type: "audio", data: "", mimeType: "audio/wav" }] }],
      maxTokens: 10,
    })
    expect(result).toBeInstanceOf(McpSampling.SamplingError)
    if (!(result instanceof McpSampling.SamplingError)) throw new Error("unreachable")
    expect(result.message).toMatch(/empty/)
  })

  test("a wrong MIME for the declared modality is rejected", () => {
    const data = Buffer.from("x").toString("base64")
    const result = McpSampling.convertMessages({
      messages: [{ role: "user", content: [{ type: "audio", data, mimeType: "text/plain" }] }],
      maxTokens: 10,
    })
    expect(result).toBeInstanceOf(McpSampling.SamplingError)
    if (!(result instanceof McpSampling.SamplingError)) throw new Error("unreachable")
    expect(result.message).toMatch(/invalid audio mimeType/)
    expect(result.data).toEqual({ mimeType: "text/plain" })
  })

  test("an oversize systemPrompt is rejected before any model work", () => {
    const result = McpSampling.convertMessages({
      ...textRequest("hi"),
      systemPrompt: "x".repeat(ModelCapability.DEFAULT_MAX_TEXT_BYTES + 1),
    })
    expect(result).toBeInstanceOf(McpSampling.SamplingError)
    if (!(result instanceof McpSampling.SamplingError)) throw new Error("unreachable")
    expect(result.message).toMatch(/systemPrompt exceeds/)
  })

  test("tools/toolChoice are refused because sampling.tools is not declared", () => {
    for (const extra of [{ tools: [] }, { toolChoice: { mode: "auto" } }]) {
      const result = McpSampling.convertMessages({ ...textRequest("hi"), ...extra })
      expect(result).toBeInstanceOf(McpSampling.SamplingError)
      if (!(result instanceof McpSampling.SamplingError)) throw new Error("unreachable")
      expect(result.message).toMatch(/does not declare sampling\.tools/)
    }
  })

  test("structural problems are rejected", () => {
    const cases: Array<[object, RegExp]> = [
      [{ messages: [], maxTokens: 10 }, /non-empty array/],
      [{ ...textRequest("hi"), maxTokens: 0 }, /positive integer/],
      [{ ...textRequest("hi"), maxTokens: 1.5 }, /positive integer/],
      [{ ...textRequest("hi"), temperature: Number.NaN }, /finite number/],
      [{ messages: [{ role: "system", content: { type: "text", text: "x" } }], maxTokens: 10 }, /unsupported message role/],
      [{ messages: [{ role: "user", content: [] }], maxTokens: 10 }, /at least one content block/],
      [
        { messages: [{ role: "user", content: [{ type: "video", data: "AAAA", mimeType: "video/mp4" }] }], maxTokens: 10 },
        /unsupported content type/,
      ],
    ]
    for (const [params, pattern] of cases) {
      const result = McpSampling.convertMessages(params as never)
      expect(result).toBeInstanceOf(McpSampling.SamplingError)
      if (!(result instanceof McpSampling.SamplingError)) throw new Error(`expected failure for ${JSON.stringify(params)}`)
      expect(result.message).toMatch(pattern)
    }
  })

  test("no provider credential can appear in a validation error", () => {
    const result = McpSampling.convertMessages({
      messages: [{ role: "user", content: [{ type: "audio", data: "!!!!", mimeType: "audio/wav" }] }],
      maxTokens: 10,
      metadata: { apiKey: "sk-should-never-echo", baseURL: "https://evil.example" },
    })
    expect(result).toBeInstanceOf(McpSampling.SamplingError)
    if (!(result instanceof McpSampling.SamplingError)) throw new Error("unreachable")
    const serialized = JSON.stringify({ message: result.message, data: result.data })
    expect(serialized).not.toContain("sk-should-never-echo")
    expect(serialized).not.toContain("evil.example")
  })
})

describe("policyFor", () => {
  test("defaults to ask when unset, null, or an unknown value", () => {
    expect(McpSampling.policyFor({}, "srv")).toBe("ask")
    expect(McpSampling.policyFor({ mcp: {} }, "srv")).toBe("ask")
    expect(McpSampling.policyFor({ mcp: { srv: {} } }, "srv")).toBe("ask")
    // A nullable source arriving as null must NOT be read as "configured".
    expect(McpSampling.policyFor({ mcp: { srv: { sampling: null as never } } }, "srv")).toBe("ask")
    expect(McpSampling.policyFor({ mcp: { srv: { sampling: "nonsense" as never } } }, "srv")).toBe("ask")
  })

  test("honours each explicit per-server policy", () => {
    expect(McpSampling.policyFor({ mcp: { srv: { sampling: "deny" } } }, "srv")).toBe("deny")
    expect(McpSampling.policyFor({ mcp: { srv: { sampling: "allow" } } }, "srv")).toBe("allow")
    expect(McpSampling.policyFor({ mcp: { srv: { sampling: "ask" } } }, "srv")).toBe("ask")
  })

  test("policy is per server, not global", () => {
    const config = { mcp: { a: { sampling: "allow" as const }, b: { sampling: "deny" as const } } }
    expect(McpSampling.policyFor(config, "a")).toBe("allow")
    expect(McpSampling.policyFor(config, "b")).toBe("deny")
    expect(McpSampling.policyFor(config, "c")).toBe("ask")
  })
})

describe("preview", () => {
  test("collapses whitespace and truncates long prompts so logs stay bounded", () => {
    expect(McpSampling.preview(undefined)).toBeUndefined()
    expect(McpSampling.preview("  a\n\tb  ")).toBe("a b")
    const long = McpSampling.preview("y".repeat(500))
    expect(long).toHaveLength(201)
    expect(long?.endsWith("…")).toBe(true)
  })
})

describe("SamplingError", () => {
  test("maps onto a JSON-RPC error preserving code, message and data", () => {
    const error = new McpSampling.SamplingError(-1, "nope", { server: "srv" })
    const mapped = error.toMcpError()
    expect(mapped.code).toBe(-1)
    expect(mapped.message).toContain("nope")
    expect(mapped.data).toEqual({ server: "srv" })
  })
})
