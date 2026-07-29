import { Effect, Cause, Exit, Fiber, Option } from "effect"
import { generateText, type ModelMessage } from "ai"
import { CreateMessageRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config"
import { Permission } from "@/permission"
import { Provider, ProviderTransform, ModelCapability } from "@/provider"
import { InstallationVersion } from "@/installation/version"
import { Log } from "@/util"
import type { SessionID } from "@/session/schema"

const log = Log.create({ service: "mcp.sampling" })

/**
 * MCP client-side sampling (`sampling/createMessage`).
 *
 * An MCP server asks US to run a model call on its behalf, so the server never
 * needs its own API key. Everything about which model runs, whether the user
 * agreed, and what the payload may contain is decided here — the server only
 * expresses preferences.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25/client/sampling
 */

/** Wall-clock ceiling on one sampling request, including the human approval wait. */
export const DEFAULT_SAMPLING_TIMEOUT = 120_000

/** How much of a prompt is shown in the approval dialog and in logs. */
const PREVIEW_LENGTH = 200

export type Policy = "deny" | "ask" | "allow"

export const PERMISSION = "mcp_sampling"

/**
 * Non-standard JSON-RPC code for "a human refused". Distinct from InvalidParams
 * so a server can tell "you asked wrong" from "the user said no" and stop
 * retrying. -1 is the code the MCP reference servers already expect for this.
 */
export const REJECTED_CODE = -1

/** The SDK's own RequestTimeout code, reused so servers see a familiar value. */
export const TIMEOUT_CODE = ErrorCode.RequestTimeout

export interface AudioSummary {
  readonly mimeType: string
  readonly bytes: number
}

export interface RequestSummary {
  readonly server: string
  readonly contentTypes: ReadonlyArray<string>
  readonly audio: ReadonlyArray<AudioSummary>
  readonly systemPrompt?: string
  readonly textPrompt?: string
}

interface SamplingContentText {
  type: "text"
  text: string
}

interface SamplingContentMedia {
  type: "image" | "audio"
  data: string
  mimeType: string
}

type SamplingContent = SamplingContentText | SamplingContentMedia

export interface SamplingMessage {
  role: "user" | "assistant"
  content: SamplingContent | ReadonlyArray<SamplingContent>
}

export interface CreateMessageParams {
  messages: ReadonlyArray<SamplingMessage>
  systemPrompt?: string
  includeContext?: "none" | "thisServer" | "allServers"
  maxTokens: number
  temperature?: number
  stopSequences?: ReadonlyArray<string>
  metadata?: Record<string, unknown>
  modelPreferences?: {
    hints?: ReadonlyArray<{ name?: string }>
    costPriority?: number
    speedPriority?: number
    intelligencePriority?: number
  }
  tools?: unknown
  toolChoice?: unknown
}

export interface CreateMessageResult {
  role: "assistant"
  content: SamplingContentText
  model: string
  stopReason: string
}

/**
 * A structured failure that maps 1:1 onto a JSON-RPC error. Carried on the
 * Effect FAILURE channel (never thrown inside Effect.fn, which would make it a
 * defect that Effect.catch cannot see — see tool/session.ts:801-807).
 */
export class SamplingError extends Error {
  readonly code: number
  readonly data: Record<string, unknown> | undefined
  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message)
    this.name = "SamplingError"
    this.code = code
    this.data = data
  }
  toMcpError(): McpError {
    return new McpError(this.code, this.message, this.data)
  }
}

function invalidParams(message: string, data?: Record<string, unknown>) {
  return new SamplingError(ErrorCode.InvalidParams, message, data)
}

/**
 * Base64 with no whitespace, correct padding, and a length that is a multiple of
 * 4. Deliberately strict: a lenient decode would let malformed audio reach the
 * provider and fail there with a far worse error.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export function decodedByteLength(data: string): number | undefined {
  if (data.length === 0) return 0
  if (data.length % 4 !== 0) return undefined
  if (!BASE64.test(data)) return undefined
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  // Padding may only appear in the final quantum.
  if (data.slice(0, -4).includes("=")) return undefined
  return (data.length / 4) * 3 - padding
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

export function normalizeMime(mimeType: string, modality: "image" | "audio") {
  const value = mimeType.trim().split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (!MIME.test(value)) return undefined
  if (!value.startsWith(`${modality}/`)) return undefined
  return value
}

interface Converted {
  readonly messages: ModelMessage[]
  readonly requirements: ModelCapability.ContentRequirement[]
  readonly summary: Omit<RequestSummary, "server">
}

function toArray(content: SamplingContent | ReadonlyArray<SamplingContent>): ReadonlyArray<SamplingContent> {
  return Array.isArray(content) ? content : [content as SamplingContent]
}

/**
 * Validate the server's content and convert it into ai-sdk `ModelMessage`s.
 *
 * Media becomes a real `file` part carrying raw bytes with its media type — the
 * same shape the session multimodal path produces (see message-v2.ts and the
 * `mediaType` routing in tool-attachment.ts). Audio is NEVER stringified into a
 * text part; a model that cannot take audio must be rejected, not fed a lie.
 */
export function convertMessages(params: CreateMessageParams): Converted | SamplingError {
  if (params.tools !== undefined || params.toolChoice !== undefined) {
    // Spec: the client MUST error when `tools` is present without having
    // declared `sampling.tools`, which we deliberately do not declare yet.
    return invalidParams("this client does not declare sampling.tools; remove tools/toolChoice", {
      declaredCapabilities: { sampling: {} },
    })
  }
  if (!Array.isArray(params.messages) || params.messages.length === 0) {
    return invalidParams("messages must be a non-empty array")
  }
  if (!Number.isInteger(params.maxTokens) || params.maxTokens <= 0) {
    return invalidParams("maxTokens must be a positive integer")
  }
  if (params.temperature !== undefined && (typeof params.temperature !== "number" || !isFinite(params.temperature))) {
    return invalidParams("temperature must be a finite number")
  }

  const messages: ModelMessage[] = []
  const requirements: ModelCapability.ContentRequirement[] = []
  const contentTypes = new Set<string>()
  const audio: AudioSummary[] = []
  let textPrompt: string | undefined

  const systemBytes = Buffer.byteLength(params.systemPrompt ?? "", "utf8")
  if (systemBytes > ModelCapability.DEFAULT_MAX_TEXT_BYTES) {
    return invalidParams("systemPrompt exceeds the maximum size", {
      bytes: systemBytes,
      maxBytes: ModelCapability.DEFAULT_MAX_TEXT_BYTES,
    })
  }

  for (const message of params.messages) {
    if (message?.role !== "user" && message?.role !== "assistant") {
      return invalidParams(`unsupported message role "${String(message?.role)}"`)
    }
    const parts: Array<
      { type: "text"; text: string } | { type: "file"; data: string; mediaType: string }
    > = []
    for (const item of toArray(message.content)) {
      if (item?.type === "text") {
        if (typeof item.text !== "string") return invalidParams("text content must be a string")
        const bytes = Buffer.byteLength(item.text, "utf8")
        contentTypes.add("text")
        requirements.push({ modality: "text", bytes })
        parts.push({ type: "text", text: item.text })
        if (message.role === "user" && textPrompt === undefined) textPrompt = item.text
        continue
      }
      if (item?.type === "image" || item?.type === "audio") {
        const modality = item.type
        if (typeof item.data !== "string") return invalidParams(`${modality} content data must be a base64 string`)
        if (typeof item.mimeType !== "string") return invalidParams(`${modality} content requires a mimeType`)
        const mimeType = normalizeMime(item.mimeType, modality)
        if (!mimeType) {
          return invalidParams(`invalid ${modality} mimeType "${item.mimeType}"`, { mimeType: item.mimeType })
        }
        const bytes = decodedByteLength(item.data)
        if (bytes === undefined) return invalidParams(`${modality} content data is not valid base64`)
        if (bytes === 0) return invalidParams(`${modality} content data is empty`)
        contentTypes.add(modality)
        if (modality === "audio") audio.push({ mimeType, bytes })
        requirements.push({ modality, mimeType, bytes })
        parts.push({ type: "file", data: item.data, mediaType: mimeType })
        continue
      }
      return invalidParams(`unsupported content type "${String((item as { type?: unknown })?.type)}"`)
    }
    if (parts.length === 0) return invalidParams("each message must carry at least one content block")
    messages.push({ role: message.role, content: parts } as ModelMessage)
  }

  return {
    messages,
    requirements,
    summary: {
      contentTypes: [...contentTypes],
      audio,
      systemPrompt: preview(params.systemPrompt),
      textPrompt: preview(textPrompt),
    },
  }
}

export function preview(value: string | undefined) {
  if (!value) return undefined
  const clean = value.replace(/\s+/g, " ").trim()
  if (clean.length <= PREVIEW_LENGTH) return clean
  return `${clean.slice(0, PREVIEW_LENGTH)}…`
}

export function policyFor(config: { mcp?: Record<string, { sampling?: Policy } | undefined> }, server: string): Policy {
  // A nullable/absent config field arrives as undefined OR null depending on
  // where it was parsed from, so discriminate on truthiness rather than on
  // `=== undefined`, which would silently treat null as "configured".
  const configured = config.mcp?.[server]?.sampling
  if (configured === "deny" || configured === "allow" || configured === "ask") return configured
  return "ask"
}

function mapStopReason(finishReason: string | undefined, stopSequences: ReadonlyArray<string> | undefined) {
  if (finishReason === "length") return "maxTokens"
  if (finishReason === "stop") return stopSequences && stopSequences.length > 0 ? "stopSequence" : "endTurn"
  return finishReason ?? "endTurn"
}

export interface HandleInput {
  readonly server: string
  readonly params: CreateMessageParams
  /**
   * Session the approval prompt belongs to. Absent when no turn is in flight for
   * this client; under the `ask` policy that fails closed rather than raising a
   * prompt no UI is listening to.
   */
  readonly sessionID: SessionID | undefined
  readonly signal?: AbortSignal
}

/**
 * Run one sampling request end to end. Fails with `SamplingError` only — the
 * caller turns that into a JSON-RPC error response.
 */
export const handle = Effect.fn("MCP.sampling.handle")(function* (input: HandleInput) {
  const started = Date.now()
  const cfgSvc = yield* Config.Service
  const provider = yield* Provider.Service
  const permission = yield* Permission.Service
  const cfg = yield* cfgSvc.get()

  const policy = policyFor(cfg as never, input.server)
  if (policy === "deny") {
    return yield* Effect.fail(
      new SamplingError(REJECTED_CODE, `sampling is denied for MCP server "${input.server}"`, {
        server: input.server,
        policy,
      }),
    )
  }

  const converted = convertMessages(input.params)
  if (converted instanceof SamplingError) return yield* Effect.fail(converted)

  const summary: RequestSummary = { server: input.server, ...converted.summary }

  // Model selection: capability + credentials FIRST, hints only to rank.
  const providers = yield* provider.list()
  const configured = Object.values(providers).flatMap((info) => Object.values(info.models))
  const fallbackRef = yield* provider.defaultModel().pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  const fallback = fallbackRef
    ? yield* provider
        .getModel(fallbackRef.providerID, fallbackRef.modelID)
        .pipe(Effect.catchDefect(() => Effect.succeed(undefined)), Effect.catchCause(() => Effect.succeed(undefined)))
    : undefined

  const selection = ModelCapability.selectModel({
    models: configured,
    requirements: converted.requirements,
    hints: input.params.modelPreferences?.hints,
    fallback,
  })

  if (!selection.ok) {
    return yield* Effect.fail(
      new SamplingError(ErrorCode.InvalidParams, "no configured model can accept this sampling request", {
        server: input.server,
        required: selection.requirements.map((item) => ({
          modality: item.modality,
          mimeType: item.mimeType,
          bytes: item.bytes,
        })),
        rejected: selection.rejections.map((item) => ({
          model: item.model,
          reason: ModelCapability.describeRejection(item.reason),
        })),
      }),
    )
  }

  const model = selection.model
  const modelRef = ModelCapability.modelRef(model)

  if (policy === "ask") {
    const sessionID = input.sessionID
    if (!sessionID) {
      // Fail closed: an `ask` with no session would publish a prompt no client
      // is listening for, and waiting on it would hang the server's request.
      return yield* Effect.fail(
        new SamplingError(
          REJECTED_CODE,
          `sampling for MCP server "${input.server}" needs approval but no active session is available`,
          { server: input.server, model: modelRef, policy },
        ),
      )
    }
    yield* permission
      .ask(
        {
          sessionID,
          permission: PERMISSION,
          patterns: [input.server],
          always: [input.server],
          ruleset: Permission.fromConfig(cfg.permission ?? {}),
          metadata: {
            server: input.server,
            model: modelRef,
            requestedModel: input.params.modelPreferences?.hints?.map((hint) => hint.name).filter(Boolean) ?? [],
            contentTypes: summary.contentTypes,
            audio: summary.audio,
            systemPrompt: summary.systemPrompt,
            textPrompt: summary.textPrompt,
            maxTokens: input.params.maxTokens,
          },
        },
        input.signal,
      )
      .pipe(
        Effect.catch((error) =>
          Effect.fail(
            new SamplingError(REJECTED_CODE, `the user declined sampling for MCP server "${input.server}"`, {
              server: input.server,
              model: modelRef,
              reason: error._tag,
            }),
          ),
        ),
      )
  }

  const language = yield* provider
    .getLanguage(model)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new SamplingError(ErrorCode.InternalError, "failed to initialise the selected model", {
            model: modelRef,
            // Cause.pretty of a plain Error renders only its message, so no
            // provider credential can ride along here.
            detail: Cause.pretty(cause).split("\n")[0],
          }),
        ),
      ),
    )

  const result = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model: language,
        system: input.params.systemPrompt,
        messages: converted.messages,
        maxOutputTokens: Math.min(input.params.maxTokens, ProviderTransform.maxOutputTokens(model)),
        temperature: model.capabilities.temperature ? input.params.temperature : undefined,
        stopSequences: input.params.stopSequences ? [...input.params.stopSequences] : undefined,
        providerOptions: ProviderTransform.providerOptions(model, {}),
        headers: { ...model.headers, "User-Agent": `mimocode/${InstallationVersion}` },
        abortSignal: input.signal,
        maxRetries: 1,
      }),
    catch: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (input.signal?.aborted) {
        return new SamplingError(ErrorCode.RequestTimeout, "sampling was cancelled", { server: input.server })
      }
      return new SamplingError(ErrorCode.InternalError, "the model provider failed to complete sampling", {
        server: input.server,
        model: modelRef,
        detail: message,
      })
    },
  })

  // The model's text is returned verbatim: no summarising, no rewriting.
  const text = result.text ?? ""
  log.info("sampling completed", {
    server: input.server,
    model: modelRef,
    via: selection.via,
    contentTypes: summary.contentTypes,
    audioBytes: summary.audio.reduce((total, item) => total + item.bytes, 0),
    duration: Date.now() - started,
    status: "ok",
  })

  return {
    role: "assistant" as const,
    content: { type: "text" as const, text },
    model: modelRef,
    stopReason: mapStopReason(result.finishReason, input.params.stopSequences),
  } satisfies CreateMessageResult
})

/**
 * Session of the turn a client is currently serving, used to address the sampling
 * approval prompt at the right session. Written when a tool call starts and read
 * by the sampling handler, which by definition runs while that call is still in
 * flight. A WeakMap so a discarded client takes its entry with it.
 */
const activeSessions = new WeakMap<object, SessionID>()

export function setActiveSession(client: object, sessionID: SessionID) {
  activeSessions.set(client, sessionID)
}

/** In-flight sampling fibers per client, interrupted when the client goes away. */
const inFlight = new WeakMap<object, Set<Fiber.Fiber<unknown, unknown>>>()

/** Interrupt every sampling request still running for a client. */
export function cancelAll(client: object) {
  const fibers = inFlight.get(client)
  if (!fibers) return Effect.void
  const pending = [...fibers]
  fibers.clear()
  return Effect.forEach(pending, (fiber) => Fiber.interrupt(fiber).pipe(Effect.ignore), {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.ignore)
}

/** How many sampling requests are currently running for a client. Test-facing. */
export function inFlightCount(client: object) {
  return inFlight.get(client)?.size ?? 0
}

/**
 * The subset of the MCP `Client` surface this module drives. Typed loosely on
 * purpose: the SDK's own `setRequestHandler` signature is generic over the Zod
 * schema and infers a result type we satisfy structurally, so pinning it exactly
 * here would only couple this module to SDK internals.
 */
export interface SamplingClient {
  setRequestHandler(
    schema: typeof CreateMessageRequestSchema,
    handler: (request: { params?: unknown }, extra?: { signal?: AbortSignal }) => Promise<never>,
  ): void
}

export interface Bridge {
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
}

/**
 * Register the server->client `sampling/createMessage` handler on a connected
 * client.
 *
 * DEADLOCK AVOIDANCE. Two independent facts make a nested sampling request safe
 * while we are parked on that same server's `tools/call`:
 *
 *  1. The SDK dispatches inbound requests from the transport's `onmessage`
 *     WITHOUT awaiting the handler (sdk/shared/protocol.js `_onrequest`), so our
 *     work never blocks the read loop that must later deliver the tool result.
 *  2. Our work runs through `bridge.fork`, i.e. a FRESH ROOT FIBER that shares no
 *     fiber, lock or scope with the fiber awaiting `client.callTool`.
 *
 * Both directions therefore make progress independently.
 */
export function serve(server: string, client: SamplingClient, bridge: Bridge) {
  client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
    const params = (request.params ?? {}) as CreateMessageParams
    // Effect 4 exposes no `timeoutFail` (it survives only in doc comments), so
    // the deadline is expressed as timeoutOption plus an explicit failure.
    const effect = handle({
      server,
      params,
      sessionID: activeSessions.get(client),
      signal: extra?.signal,
    }).pipe(
      Effect.timeoutOption(DEFAULT_SAMPLING_TIMEOUT),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(
              new SamplingError(TIMEOUT_CODE, "sampling timed out", {
                server,
                timeout: DEFAULT_SAMPLING_TIMEOUT,
              }),
            ),
      ),
      Effect.exit,
    )

    let fibers = inFlight.get(client)
    if (!fibers) {
      fibers = new Set()
      inFlight.set(client, fibers)
    }
    const fiber = bridge.fork(effect)
    fibers.add(fiber as Fiber.Fiber<unknown, unknown>)
    try {
      const exit = await Effect.runPromise(Fiber.join(fiber))
      if (Exit.isSuccess(exit)) return exit.value as never
      // `handle` puts SamplingError on the FAILURE channel, so squash returns the
      // instance itself and `instanceof` survives. A cancelled fiber and a
      // genuine defect both land here and become explicit errors.
      const failure = Cause.squash(exit.cause)
      if (failure instanceof SamplingError) throw failure.toMcpError()
      if (Cause.hasInterrupts(exit.cause)) {
        log.info("sampling cancelled", { server, status: "cancelled" })
        throw new McpError(TIMEOUT_CODE, "sampling was cancelled", { server })
      }
      log.error("sampling failed", { server, status: "error" })
      throw new McpError(ErrorCode.InternalError, "sampling failed")
    } finally {
      fibers.delete(fiber as Fiber.Fiber<unknown, unknown>)
    }
  })
}

export * as McpSampling from "./sampling"
