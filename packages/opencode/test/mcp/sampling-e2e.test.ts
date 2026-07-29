import { test, expect, describe, afterEach } from "bun:test"
import path from "path"
import { Effect } from "effect"
import type { Client as ClientType } from "@modelcontextprotocol/sdk/client/index.js"
import type { McpServer as McpServerType } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod/v4"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import { EffectBridge } from "../../src/effect"
import { McpSampling } from "../../src/mcp/sampling"
import { MCP } from "../../src/mcp/index"
import { Permission } from "../../src/permission"
import type { SessionID } from "../../src/session/schema"
import { wav } from "./sampling.test"

/**
 * END-TO-END proof of MCP client-side sampling over a REAL bidirectional
 * JSON-RPC link.
 *
 * A real SDK `McpServer` exposes `transcribe_audio_fixture`. While that tool is
 * executing — i.e. while our side is still awaiting the `tools/call` response —
 * the server issues `sampling/createMessage` back at us carrying a 16 kHz mono
 * WAV. Our production handler (`McpSampling.serve`, the same function
 * `src/mcp/index.ts` wires up) selects a model, runs it, and answers. The server
 * then finishes its tool call with the transcript it received.
 *
 * The provider is mocked at the HTTP boundary only, so the audio genuinely passes
 * through the real `@ai-sdk/openai-compatible` conversion layer and we can assert
 * on the bytes that reached the wire. No real model and no real API key are used.
 *
 * THE SDK IS LOADED FROM ITS CJS BUILD ON PURPOSE. Sibling files
 * (lifecycle.test.ts, oauth-*.test.ts) call
 * `mock.module("@modelcontextprotocol/sdk/client/index.js")` at module scope.
 * Bun's module mocks are process-wide, survive across test files, cannot be
 * bypassed by importing the same module through an absolute path or a file URL,
 * and CI shards by file — so which mocks are live when this file runs is not
 * something a file name can control. The package's `dist/cjs` tree is a different
 * set of physical files and therefore a different set of module records, so it is
 * immune. Every SDK value below comes from that single realm so no cross-realm
 * classes are mixed. The `harness integrity` test fails loudly if this ever stops
 * yielding the genuine `Client`.
 */

/** The real SDK, loaded from `dist/cjs` so no `mock.module` can intercept it. */
const sdk = await (async () => {
  const esmEntry = Bun.resolveSync("@modelcontextprotocol/sdk/client/index.js", import.meta.dir)
  const cjsClient = esmEntry.replace(`${path.sep}esm${path.sep}`, `${path.sep}cjs${path.sep}`)
  const cjsDir = path.dirname(path.dirname(cjsClient))
  const load = async (relative: string) => {
    const mod: any = await import(path.join(cjsDir, relative))
    return mod.Client || mod.McpServer || mod.InMemoryTransport || mod.CallToolResultSchema ? mod : mod.default
  }
  const [client, server, inMemory, types] = await Promise.all([
    load("client/index.js"),
    load("server/mcp.js"),
    load("inMemory.js"),
    load("types.js"),
  ])
  return {
    Client: client.Client as unknown as typeof ClientType,
    McpServer: server.McpServer as unknown as typeof McpServerType,
    InMemoryTransport: inMemory.InMemoryTransport,
    CallToolResultSchema: types.CallToolResultSchema,
    CreateMessageResultSchema: types.CreateMessageResultSchema,
  }
})()

const { Client, McpServer, InMemoryTransport, CallToolResultSchema, CreateMessageResultSchema } = sdk

const TRANSCRIPT = "the quick brown fox jumps over the lazy dog"
const SESSION = "ses_sampling_e2e" as SessionID

// A single self-contained config provider. `npm` + `models` + `apiKey` are all
// declared so the provider loads deterministically without env-key autoload,
// mirroring test/provider/model-groups.test.ts.
const PROVIDER_ID = "samplingfixture"

const PROVIDERS = {
  [PROVIDER_ID]: {
    name: "Sampling Fixture",
    npm: "@ai-sdk/openai-compatible",
    env: [],
    api: "https://example.invalid/v1",
    options: { apiKey: "test-key", baseURL: "https://example.invalid/v1" },
    models: {
      "mimo-v2.5": {
        name: "MiMo v2.5",
        tool_call: true,
        modalities: { input: ["text", "image", "audio"], output: ["text"] },
        limit: { context: 128_000, output: 8_000 },
      },
      "mimo-text-only": {
        name: "MiMo Text Only",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128_000, output: 8_000 },
      },
    },
  },
}

interface Wire {
  bodies: Array<any>
  restore: () => void
}

/** Replace global fetch with an OpenAI-compatible chat-completions stub. */
function stubProvider(text: string): Wire {
  const original = globalThis.fetch
  const bodies: Array<any> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const href = typeof url === "string" ? url : (url?.url ?? String(url))
    if (!href.includes("example.invalid")) return original(url, init)
    bodies.push(JSON.parse(init.body as string))
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "mimo-v2.5",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
      { headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  return { bodies, restore: () => (globalThis.fetch = original) }
}

let wire: Wire | undefined
afterEach(() => {
  wire?.restore()
  wire = undefined
})

interface Harness {
  client: ClientType
  server: McpServerType
  /** Sampling requests the server issued, and what it got back. */
  samplingOutcomes: Array<{ ok: boolean; detail: unknown }>
  /** True while the fixture tool is mid-execution. */
  toolActive: () => boolean
}

/**
 * A real client/server pair over InMemoryTransport, with our production sampling
 * handler registered on the client exactly as `src/mcp/index.ts` registers it.
 */
async function harness(input: {
  audio?: { data: string; mimeType: string }
  hints?: Array<{ name: string }>
  text?: string
  /** Abort the sampling request once a permission prompt is pending. */
  cancelAfterAsk?: boolean
}): Promise<Harness> {
  const server = new McpServer({ name: "fixture", version: "1.0.0" })
  const samplingOutcomes: Array<{ ok: boolean; detail: unknown }> = []
  let active = false

  server.registerTool(
    "transcribe_audio_fixture",
    {
      description: "Transcribes bundled fixture audio by asking the client to sample a model.",
      inputSchema: { note: z.string().optional() },
    },
    async () => {
      active = true
      try {
        // Server -> client REQUEST issued while the client is still awaiting this
        // tool's own response. If either direction blocked the other, this await
        // would never settle.
        const content = input.audio
          ? [
              { type: "text" as const, text: "Transcribe this audio verbatim." },
              { type: "audio" as const, data: input.audio.data, mimeType: input.audio.mimeType },
            ]
          : [{ type: "text" as const, text: input.text ?? "say hello" }]
        const controller = new AbortController()
        if (input.cancelAfterAsk) {
          // Burn JSON-RPC request id 0 first. The SDK drops a cancellation whose
          // `requestId` is 0 (`if (!notification.params.requestId) return` in
          // shared/protocol.js), so the FIRST server-initiated request of a
          // connection is uncancellable upstream. Cancelling a later request
          // exercises the path our handler actually has to survive.
          await server.server.ping()
          // Cancel as soon as the client has raised its approval prompt, i.e.
          // while our handler is genuinely parked mid-request.
          void waitForAsk().then(
            () => controller.abort(new Error("server cancelled sampling")),
            () => controller.abort(new Error("server cancelled sampling")),
          )
        }
        const result = await server.server.request(
          {
            method: "sampling/createMessage",
            params: {
              messages: [{ role: "user", content }],
              systemPrompt: "You are a verbatim transcription engine.",
              maxTokens: 2048,
              ...(input.hints ? { modelPreferences: { hints: input.hints } } : {}),
            },
          },
          CreateMessageResultSchema,
          { signal: controller.signal },
        )
        samplingOutcomes.push({ ok: true, detail: result })
        return { content: [{ type: "text", text: (result.content as { text: string }).text }] }
      } catch (error: any) {
        samplingOutcomes.push({ ok: false, detail: { code: error?.code, message: error?.message, data: error?.data } })
        return { content: [{ type: "text", text: `SAMPLING_ERROR ${error?.code}` }], isError: true }
      } finally {
        active = false
      }
    },
  )

  // PRODUCTION's own capability object, not a copy — so a regression that drops
  // `sampling` from src/mcp/index.ts fails these tests instead of passing against
  // a duplicated literal.
  const client = new Client({ name: "mimocode", version: "test" }, MCP.CLIENT_OPTIONS)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)])
  return { client, server, samplingOutcomes, toolActive: () => active }
}

/** Register production sampling handling on a client inside a live Instance. */
function wireSampling(client: ClientType, serverName = "fixture") {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      McpSampling.setActiveSession(client, SESSION)
      McpSampling.serve(serverName, client as never, bridge)
    }),
  )
}

/** Poll the permission service until a sampling prompt is pending. */
async function waitForAsk() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const pending = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        return yield* permission.list()
      }),
    )
    const match = pending.find((item) => item.permission === "mcp_sampling")
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("no mcp_sampling permission request was raised")
}

/** Wait, bounded, for a client's sampling fibers to retire. */
async function drainInFlight(client: object) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (McpSampling.inFlightCount(client) === 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`sampling fibers never drained (${McpSampling.inFlightCount(client)} left)`)
}

function config(extra?: Record<string, unknown>) {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: PROVIDERS,
    // `enabled_providers` is an ALLOWLIST: without it this machine's real
    // provider credentials autoload and sampling would pick a live model.
    enabled_providers: [PROVIDER_ID],
    model: `${PROVIDER_ID}/mimo-v2.5`,
    ...extra,
  }
}

async function withInstance(cfg: object, fn: () => Promise<void>) {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(cfg))
    },
  })
  await Instance.provide({ directory: tmp.path, fn })
}

describe("harness integrity", () => {
  test("the SDK Client under test is the REAL one, not a sibling file's mock", () => {
    // Real Client extends Protocol and carries these; every test double in
    // test/mcp/ carries neither. If a module mock ever wins the load-order race,
    // this fails instead of letting the whole E2E pass against a stub.
    expect(typeof (Client.prototype as any).assertRequestHandlerCapability).toBe("function")
    expect(typeof (Client.prototype as any).ping).toBe("function")
    expect(typeof (Client.prototype as any).callTool).toBe("function")
  })
})

describe("MCP client-side sampling, end to end", () => {
  test("declares the sampling capability during initialize", async () => {
    const h = await harness({ text: "hi" })
    // What the SERVER observed on the wire, not what we passed in.
    expect(h.server.server.getClientCapabilities()).toMatchObject({ sampling: {} })
    // Not-yet-implemented sub-capabilities must stay undeclared.
    const capabilities = h.server.server.getClientCapabilities() as Record<string, any>
    expect(capabilities.sampling.tools).toBeUndefined()
    expect(capabilities.sampling.context).toBeUndefined()
    await h.client.close()
  })

  test("a 30s 16kHz mono WAV round-trips through a nested sampling request without deadlock", async () => {
    wire = stubProvider(TRANSCRIPT)
    const buffer = wav(30)
    const data = buffer.toString("base64")

    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const h = await harness({ audio: { data, mimeType: "audio/wav" }, hints: [{ name: "mimo-v2.5" }] })
      await wireSampling(h.client)

      const result = await h.client.callTool(
        { name: "transcribe_audio_fixture", arguments: {} },
        CallToolResultSchema,
        { timeout: 30_000 },
      )

      // 1. The tool completed, so neither direction blocked the other. This is
      //    the self-lock gate: the fixture tool only returns AFTER its own
      //    sampling request resolved, so a sampling path that waited on the
      //    outstanding tool call would circular-wait and time out here.
      expect(result.isError).toBeFalsy()
      expect((result.content as Array<{ text: string }>)[0].text).toBe(TRANSCRIPT)

      // 2. The server's own sampling call succeeded, with the model we selected.
      expect(h.samplingOutcomes).toHaveLength(1)
      expect(h.samplingOutcomes[0].ok).toBe(true)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.model).toBe(`${PROVIDER_ID}/mimo-v2.5`)
      expect(detail.role).toBe("assistant")
      // Verbatim: exactly the provider's text, not a summary.
      expect(detail.content).toEqual({ type: "text", text: TRANSCRIPT })
      expect(detail.stopReason).toBe("endTurn")

      // 3. The WAV really reached the provider as audio, not as text.
      expect(wire!.bodies).toHaveLength(1)
      const parts = wire!.bodies[0].messages.at(-1).content
      expect(parts).toEqual([
        { type: "text", text: "Transcribe this audio verbatim." },
        { type: "input_audio", input_audio: { data, format: "wav" } },
      ])
      // 4. No credential rode along in the JSON-RPC payload the server saw.
      expect(JSON.stringify(detail)).not.toContain("test-key")
      expect(JSON.stringify(detail)).not.toContain("example.invalid")

      await h.client.close()
    })
  }, 60_000)

  // Pins the PRECONDITION for the deadlock coverage above, and is not itself a
  // deadlock proof: the SDK dispatches inbound requests from `onmessage` without
  // awaiting them (shared/protocol.js `_onrequest`), so "the request arrived
  // during the tool call" is guaranteed by the SDK and would pass for free. The
  // real self-lock coverage is the round-trip test above, which drives sampling
  // through the actual model-acquisition path to a returned CreateMessageResult
  // with the tool call still outstanding; making that path wait on the
  // outstanding tool call (a turn lock / serial prompt queue) times it out.
  test("the sampling request is served WHILE the tool call is still in flight", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      let activeDuringSampling: boolean | undefined
      const h = await harness({ text: "hi" })
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          McpSampling.setActiveSession(h.client, SESSION)
          // Wrap the production handler so we can observe tool-call state at the
          // moment the inbound request is dispatched. The handler itself is
          // production code; only the observation is added.
          const spy = {
            setRequestHandler: (schema: never, handler: never) => {
              h.client.setRequestHandler(schema, (async (request: any, extra: any) => {
                activeDuringSampling = h.toolActive()
                return (handler as any)(request, extra)
              }) as never)
            },
          }
          McpSampling.serve("fixture", spy as never, bridge)
        }),
      )

      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBeFalsy()
      // The proof: the fixture tool had NOT returned when we began sampling.
      expect(activeDuringSampling).toBe(true)
      await h.client.close()
    })
  }, 60_000)

  test("audio is refused when only text-capable models are configured, and never downgraded", async () => {
    wire = stubProvider(TRANSCRIPT)
    const data = wav(1).toString("base64")
    const textOnly = {
      ...config(),
      model: `${PROVIDER_ID}/mimo-text-only`,
      provider: {
        [PROVIDER_ID]: {
          ...PROVIDERS[PROVIDER_ID],
          models: { "mimo-text-only": PROVIDERS[PROVIDER_ID].models["mimo-text-only"] },
        },
      },
      mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } },
    }
    await withInstance(textOnly, async () => {
      const h = await harness({ audio: { data, mimeType: "audio/wav" } })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      expect(h.samplingOutcomes[0].ok).toBe(false)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.code).toBe(-32602)
      expect(detail.message).toMatch(/no configured model can accept/)
      // The structured error names the model and the reason.
      expect(detail.data.rejected).toEqual([
        { model: `${PROVIDER_ID}/mimo-text-only`, reason: "does not accept audio input" },
      ])
      expect(detail.data.required).toContainEqual({ modality: "audio", mimeType: "audio/wav", bytes: 32044 })
      // Nothing was sent to any provider: no silent downgrade to a text call.
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
    })
  }, 60_000)

  test("policy deny refuses before any model or provider work", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "deny" } } }), async () => {
      const h = await harness({ text: "hi" })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.code).toBe(-1)
      expect(detail.message).toMatch(/denied/)
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
    })
  }, 60_000)

  test("policy ask requires approval: a rejected ask fails the request", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(
      config({
        // No `sampling` key at all → the default policy must be `ask`.
        mcp: { fixture: { type: "local", command: ["true"] } },
        permission: { mcp_sampling: "deny" },
      }),
      async () => {
        const h = await harness({ text: "hi" })
        await wireSampling(h.client)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        expect(result.isError).toBe(true)
        const detail = h.samplingOutcomes[0].detail as any
        expect(detail.code).toBe(-1)
        expect(detail.message).toMatch(/declined/)
        expect(wire!.bodies).toHaveLength(0)
        await h.client.close()
      },
    )
  }, 60_000)

  test("policy ask proceeds when the user approves", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(
      config({
        mcp: { fixture: { type: "local", command: ["true"] } },
        permission: { mcp_sampling: "allow" },
      }),
      async () => {
        const h = await harness({ text: "hi" })
        await wireSampling(h.client)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        expect(result.isError).toBeFalsy()
        expect(h.samplingOutcomes[0].ok).toBe(true)
        await h.client.close()
      },
    )
  }, 60_000)

  test("concurrent sampling requests all complete", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const h = await harness({ text: "hi" })
      await wireSampling(h.client)
      const results = await Promise.all(
        [0, 1, 2, 3].map(() =>
          h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
            timeout: 30_000,
          }),
        ),
      )
      for (const result of results) expect(result.isError).toBeFalsy()
      expect(h.samplingOutcomes).toHaveLength(4)
      expect(h.samplingOutcomes.every((item) => item.ok)).toBe(true)
      // Every fiber was retired from the in-flight set.
      expect(McpSampling.inFlightCount(h.client)).toBe(0)
      await h.client.close()
    })
  }, 60_000)

  test("an oversize audio payload is refused with a structured error", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      // 4 base64 chars per 3 bytes; ask for one byte past the cap.
      const bytes = 20 * 1024 * 1024 + 3
      const data = "A".repeat(Math.ceil(bytes / 3) * 4)
      const h = await harness({ audio: { data, mimeType: "audio/wav" } })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.code).toBe(-32602)
      // Both configured models are rejected, for DIFFERENT reasons: the
      // text-only one cannot take audio at all, the audio-capable one is over
      // the size cap. Assert the size verdict on the model it applies to.
      const audioCapable = detail.data.rejected.find((item: any) => item.model === `${PROVIDER_ID}/mimo-v2.5`)
      expect(audioCapable.reason).toMatch(/over the .* byte limit for audio/)
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
    })
  }, 60_000)

  // The SDK validates AudioContent.data against its own Base64 refinement while
  // parsing the inbound request, so a malformed payload is refused at the protocol
  // boundary and never reaches our handler. Our own base64 check (asserted in
  // sampling.test.ts) is the defence-in-depth layer behind it.
  test("invalid base64 audio is refused at the protocol boundary, before any model work", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const h = await harness({ audio: { data: "!!!not-base64!!!", mimeType: "audio/wav" } })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.message).toMatch(/Invalid Base64 string/)
      // Nothing reached a provider.
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
    })
  }, 60_000)

  test("a cancelled sampling request is answered with a cancellation error, not left hanging", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"] } } }), async () => {
      // Policy defaults to ask, so the request parks on human approval — a
      // deterministic point at which to cancel it.
      const h = await harness({ text: "hi", cancelAfterAsk: true })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      expect(h.samplingOutcomes).toHaveLength(1)
      expect(h.samplingOutcomes[0].ok).toBe(false)
      // The server's own request settled rather than hanging to its timeout.
      const detail = h.samplingOutcomes[0].detail as any
      expect(String(detail.message)).toMatch(/cancel/i)
      // No model call was ever made.
      expect(wire!.bodies).toHaveLength(0)
      // The fiber drains. This is polled, not asserted synchronously: the
      // server's request rejects on its own abort immediately, while our side
      // only unwinds once `notifications/cancelled` arrives and aborts the
      // handler's signal, so the two are not ordered.
      await drainInFlight(h.client)
      await h.client.close()
    })
  }, 60_000)

  test("cancelAll interrupts sampling still in flight so the server stops waiting", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"] } } }), async () => {
      const h = await harness({ text: "hi" })
      await wireSampling(h.client)
      const pending = h.client
        .callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, { timeout: 30_000 })
        .catch(() => undefined)
      // Park on the approval prompt, then tear the sampling work down underneath
      // it — the client-exit path src/mcp/index.ts runs from closeClient.
      await waitForAsk()
      expect(McpSampling.inFlightCount(h.client)).toBe(1)
      await AppRuntime.runPromise(McpSampling.cancelAll(h.client))

      // The OUTCOME, not the bookkeeping: the server's own sampling request must
      // settle with an error. Asserting only that inFlightCount dropped to 0
      // would pass even if the interrupt were a no-op, because cancelAll clears
      // its tracking set either way.
      for (let attempt = 0; attempt < 200 && h.samplingOutcomes.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(h.samplingOutcomes).toHaveLength(1)
      expect(h.samplingOutcomes[0].ok).toBe(false)
      // The interrupted request never reached a provider.
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
      await pending
    })
  }, 60_000)

  test("a server that never samples keeps working unchanged", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const server = new McpServer({ name: "plain", version: "1.0.0" })
      server.registerTool("echo", { description: "echo", inputSchema: { value: z.string() } }, async (args) => ({
        content: [{ type: "text", text: String((args as { value: string }).value) }],
      }))
      const client = new Client({ name: "mimocode", version: "test" }, MCP.CLIENT_OPTIONS)
      const [a, b] = InMemoryTransport.createLinkedPair()
      await Promise.all([client.connect(a), server.server.connect(b)])
      await wireSampling(client, "plain")
      const result = await client.callTool({ name: "echo", arguments: { value: "unchanged" } }, CallToolResultSchema)
      expect((result.content as Array<{ text: string }>)[0].text).toBe("unchanged")
      expect(wire!.bodies).toHaveLength(0)
      await client.close()
    })
  }, 60_000)
})

describe("the approval prompt", () => {
  test("carries server, model, content types and audio size, and no credentials", async () => {
    wire = stubProvider(TRANSCRIPT)
    const buffer = wav(2)
    const data = buffer.toString("base64")
    await withInstance(
      // No `permission` entry at all, and no per-server `sampling` policy, so
      // mcp_sampling defaults to ask and a real prompt must be published.
      config({ mcp: { fixture: { type: "local", command: ["true"] } } }),
      async () => {
        const h = await harness({ audio: { data, mimeType: "audio/wav" }, hints: [{ name: "mimo-v2.5" }] })
        await wireSampling(h.client)

        // Start the call WITHOUT awaiting: it cannot finish until the prompt is
        // answered, which is the behaviour under test.
        const pending = h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )

        const request = await waitForAsk()
        expect(request.permission).toBe("mcp_sampling")
        expect(request.patterns).toEqual(["fixture"])
        expect(request.metadata).toMatchObject({
          server: "fixture",
          model: `${PROVIDER_ID}/mimo-v2.5`,
          requestedModel: ["mimo-v2.5"],
          audio: [{ mimeType: "audio/wav", bytes: buffer.length }],
          systemPrompt: "You are a verbatim transcription engine.",
          textPrompt: "Transcribe this audio verbatim.",
          maxTokens: 2048,
        })
        expect([...(request.metadata.contentTypes as string[])].sort()).toEqual(["audio", "text"])

        // No credential, base URL or raw audio payload in the prompt.
        const serialized = JSON.stringify(request)
        expect(serialized).not.toContain("test-key")
        expect(serialized).not.toContain("example.invalid")
        expect(serialized).not.toContain(data.slice(0, 64))

        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const permission = yield* Permission.Service
            yield* permission.reply({ requestID: request.id, reply: "once" })
          }),
        )

        const result = await pending
        expect(result.isError).toBeFalsy()
        expect((result.content as Array<{ text: string }>)[0].text).toBe(TRANSCRIPT)
        await h.client.close()
      },
    )
  }, 60_000)

  test("a session-less sampling request under policy ask fails closed instead of hanging", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"] } } }), async () => {
      const h = await harness({ text: "hi" })
      // Deliberately NOT calling setActiveSession: no turn is in flight, so an
      // `ask` would publish a prompt nothing is listening for.
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          McpSampling.serve("fixture", h.client as never, bridge)
        }),
      )
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.code).toBe(-1)
      expect(detail.message).toMatch(/no active session/)
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
    })
  }, 60_000)
})
