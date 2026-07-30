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

/**
 * Wall-clock ceiling on the MODEL CALL. Not on the human approval wait, which
 * has its own bound — see DEFAULT_SAMPLING_APPROVAL_TIMEOUT for why the two were
 * separated. Reaching it aborts the provider call as well as our wait for it —
 * see the abort composition in `handle`.
 *
 * This is also the ABSOLUTE bound on the model call: the liveness notifications
 * `handle` emits can reset a PEER's request timer, never this one, so a provider
 * that hangs forever is still cut off here.
 *
 * WHERE 120 s COMES FROM: nowhere. No derivation and no measurement is recorded
 * for it, here or anywhere else in the repo. Compare `actor/schema.ts`'s
 * DEFAULT_LIVENESS_STALL_MS, which at least ties its 90 s to two other named
 * numbers in the system (the per-step turn cadence below it, the 5-minute
 * stuck-detection cutoff above it); this value is tied to nothing. The one thing
 * that IS known about it is a hazard, not a justification: it is 2x the MCP SDK's
 * own DEFAULT_REQUEST_TIMEOUT_MSEC (60 s, `shared/protocol.js`), so a peer that
 * left its request timeout at the default and did not opt into
 * `resetTimeoutOnProgress` abandons the request at 60 s while we keep working to
 * 120 s. Treat the value as an OPEN QUESTION, not as something already argued.
 */
export const DEFAULT_SAMPLING_TIMEOUT = 120_000

/**
 * Wall-clock ceiling on the human approval wait alone.
 *
 * THIS NUMBER IS A DEFAULT AWAITING A REAL PRODUCT DECISION, NOT A DERIVED VALUE.
 * Nothing here measures how long an operator actually takes to answer a sampling
 * prompt, so 30 s is not that. It was chosen because it satisfies one mechanical
 * constraint and no more: it is below the SDK's 60 s DEFAULT_REQUEST_TIMEOUT_MSEC,
 * so a peer running that default still has budget left for the model call after a
 * maximal approval wait. Whether 30 s is enough time for a human is undecided.
 * Overridable through `serve`'s parameter, exactly as `timeoutMs` is.
 */
export const DEFAULT_SAMPLING_APPROVAL_TIMEOUT = 30_000

/**
 * How often a liveness notification goes out while the model call is in flight.
 * Chosen under the SDK's 60 s default request timeout by enough of a margin that
 * several land inside one peer timeout window rather than one landing near its
 * edge.
 */
export const DEFAULT_LIVENESS_INTERVAL = 15_000

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

/**
 * What is needed to keep a PEER's request timer alive while we work. Neither
 * field is ours to invent: we are the CLIENT answering a server-initiated
 * request, so the token belongs to the requester's message id and only the
 * requester can mint it (`shared/protocol.js` sets
 * `params._meta.progressToken = messageId`, and only when its caller passed
 * `onprogress`). `serve` reads it back out of the request the SDK handed us and
 * builds this; when the server did not ask for progress there is no token and
 * this is `undefined`, which means we send nothing at all.
 */
export interface Liveness {
  readonly progressToken: string | number
  /** `extra.sendNotification` from the SDK request handler — this connection. */
  readonly send: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>
  readonly intervalMs: number
}

/**
 * LIVENESS, NOT PROGRESS — and the name is the point.
 *
 * The model call on this path is `generateText`, which is non-streaming; there is
 * no `streamText` anywhere in sampling, so no token-level signal exists and NO
 * COMPLETION FRACTION CAN BE COMPUTED. `progress` is therefore a monotonic TICK
 * COUNT (the spec asks only that it increase) and `total` is deliberately OMITTED
 * so no peer can divide one by the other and read a percentage that does not
 * exist. The single claim being made is: this request has not been abandoned.
 *
 * WHY IT CANNOT MASK A HUNG CALL. Two independent reasons. (1) These
 * notifications reset the timer on the PEER's side only — `_resetTimeout` in
 * `shared/protocol.js`, and only if that peer passed `resetTimeoutOnProgress`.
 * Our own bound on the model call is plain wall clock and no notification
 * touches it, so a provider that never answers is still cut off at `timeoutMs`.
 * (2) Even on the peer's side the resets are capped by its own `maxTotalTimeout`.
 *
 * Runs forever and never fails: each send is ignored, because a peer that cannot
 * receive a notification must not thereby kill the model call. Raced against the
 * model call with `raceFirst` — the model settling first (success OR failure)
 * interrupts this.
 */
function heartbeat(liveness: Liveness): Effect.Effect<never> {
  let tick = 0
  return Effect.forever(
    Effect.sleep(liveness.intervalMs).pipe(
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: () =>
            liveness.send({
              method: "notifications/progress",
              params: {
                progressToken: liveness.progressToken,
                progress: ++tick,
                message: "sampling: model call in flight",
              },
            }),
          catch: (error) => error,
        }).pipe(Effect.ignore),
      ),
    ),
  )
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
  /** Bound on the model call alone. Defaults to DEFAULT_SAMPLING_TIMEOUT. */
  readonly timeoutMs?: number
  /**
   * Bound on the approval wait alone. Defaults to
   * DEFAULT_SAMPLING_APPROVAL_TIMEOUT. Separate from `timeoutMs` so a slow human
   * cannot eat the model's budget and so the expiry can say which phase ran out.
   */
  readonly approvalTimeoutMs?: number
  /** Absent when the server did not ask for progress; then nothing is emitted. */
  readonly liveness?: Liveness
}

/**
 * Run one sampling request end to end. Fails with `SamplingError` only — the
 * caller turns that into a JSON-RPC error response.
 */
export const handle = Effect.fn("MCP.sampling.handle")(function* (input: HandleInput) {
  const started = Date.now()
  const modelTimeoutMs = input.timeoutMs ?? DEFAULT_SAMPLING_TIMEOUT
  const approvalTimeoutMs = input.approvalTimeoutMs ?? DEFAULT_SAMPLING_APPROVAL_TIMEOUT
  const cfgSvc = yield* Config.Service
  const provider = yield* Provider.Service
  const permission = yield* Permission.Service
  const cfg = yield* cfgSvc.get()

  const policy = policyFor(cfg as never, input.server)
  // TWO controls gate sampling and a `deny` from either one wins: the per-server
  // `mcp.<server>.sampling` policy, and the standard `permission.mcp_sampling`
  // ruleset. Evaluating the ruleset HERE rather than leaning on permission.ask
  // is what makes that true — `allow` skips the ask entirely, so an explicit
  // ruleset deny would otherwise never be consulted at all. Same precedence the
  // permission service applies internally (permission/index.ts:243-247): a
  // ruleset deny is not out-rankable by a more permissive setting elsewhere.
  const ruleset = Permission.fromConfig(cfg.permission ?? {})
  const ruleDenied = Permission.evaluate(PERMISSION, input.server, ruleset).action === "deny"
  if (policy === "deny" || ruleDenied) {
    return yield* Effect.fail(
      new SamplingError(REJECTED_CODE, `sampling is denied for MCP server "${input.server}"`, {
        server: input.server,
        policy,
        deniedBy: policy === "deny" ? "mcp.sampling" : "permission.mcp_sampling",
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
          ruleset,
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
        // THE APPROVAL PHASE HAS ITS OWN BOUND. Sharing one bound with the model
        // call made the model's budget a residual: a human taking 110 s of a
        // 120 s bound left the model 10 s, and a human taking all 120 s meant the
        // model was never called at all — while the server was told that
        // *sampling* timed out. The phase is named in the message and in
        // `data.phase`, so an operator knows which knob to turn and a server
        // author is not told a model was slow when nobody answered the prompt.
        Effect.timeoutOption(approvalTimeoutMs),
        Effect.flatMap((answered) =>
          Option.isSome(answered)
            ? Effect.void
            : Effect.fail(
                new SamplingError(TIMEOUT_CODE, "sampling timed out waiting for approval", {
                  server: input.server,
                  model: modelRef,
                  phase: "approval",
                  timeout: approvalTimeoutMs,
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

  // The signal actually handed to the provider. Assigned by `tryPromise` below
  // and read by its `catch`, which has to tell "we aborted this" from "the
  // provider genuinely failed" without assuming which source aborted.
  let providerSignal: AbortSignal | undefined

  const call = Effect.tryPromise({
    try: (fiberSignal: AbortSignal) => {
      // COMPOSE both abort sources. `fiberSignal` is aborted whenever this fiber
      // is interrupted, which covers the model bound below, the absolute ceiling
      // in `serve` and `cancelAll`; on its own, none of those reaches the
      // provider, because interrupting a fiber does not cancel a promise already
      // in flight inside it. `input.signal` is the MCP SDK's per-request signal
      // and covers a server-issued cancellation. Either one must stop the HTTP
      // call, so the provider gets the union of the two, not just one of them.
      providerSignal = input.signal ? AbortSignal.any([fiberSignal, input.signal]) : fiberSignal
      return generateText({
        model: language,
        system: input.params.systemPrompt,
        messages: converted.messages,
        maxOutputTokens: Math.min(input.params.maxTokens, ProviderTransform.maxOutputTokens(model)),
        temperature: model.capabilities.temperature ? input.params.temperature : undefined,
        stopSequences: input.params.stopSequences ? [...input.params.stopSequences] : undefined,
        providerOptions: ProviderTransform.providerOptions(model, {}),
        headers: { ...model.headers, "User-Agent": `mimocode/${InstallationVersion}` },
        abortSignal: providerSignal,
        maxRetries: 1,
      })
    },
    catch: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (providerSignal?.aborted ?? input.signal?.aborted) {
        return new SamplingError(ErrorCode.RequestTimeout, "sampling was cancelled", { server: input.server })
      }
      return new SamplingError(ErrorCode.InternalError, "the model provider failed to complete sampling", {
        server: input.server,
        model: modelRef,
        detail: message,
      })
    },
  })

  // KEEPALIVE, and only if the server asked for it. `raceFirst` is "first to
  // SETTLE", so the model call winning with a failure still interrupts the
  // heartbeat; `Effect.race` would be wrong here for the same reason it was wrong
  // in the approval wait — it waits for a losing side to fail and the heartbeat
  // never does. The heartbeat cannot win: it never settles.
  const kept = input.liveness ? Effect.raceFirst(call, heartbeat(input.liveness)) : call

  const result = yield* kept.pipe(
    // THE MODEL PHASE'S OWN BOUND, and our ABSOLUTE one: liveness notifications
    // reset the PEER's timer, never this. A provider that hangs forever is cut
    // off here regardless of how many heartbeats went out.
    Effect.timeoutOption(modelTimeoutMs),
    Effect.flatMap((completed) =>
      Option.isSome(completed)
        ? Effect.succeed(completed.value)
        : Effect.fail(
            new SamplingError(TIMEOUT_CODE, "sampling timed out waiting for the model", {
              server: input.server,
              model: modelRef,
              phase: "model",
              timeout: modelTimeoutMs,
            }),
          ),
    ),
  )

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

/**
 * Interrupt every sampling request still running for a client. The interrupt
 * aborts the in-flight provider call too, because `handle` hands the provider a
 * signal derived from its own fiber — see the abort composition there.
 */
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
 * The part of the SDK's request-handler `extra` this module reads. Deliberately
 * `unknown` for everything but the signal: `_meta` and `sendNotification` are
 * typed on the SDK side against a notification union that is generic over the
 * schema, and naming those types here would couple the module to SDK internals
 * for no gain — the two are narrowed at the use site instead.
 */
export interface SamplingRequestExtra {
  signal?: AbortSignal
  /** The request's own `params._meta`, passed through verbatim by `_onrequest`. */
  _meta?: unknown
  /** Sends a notification on THIS request's connection, tagged to its id. */
  sendNotification?: unknown
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
    handler: (request: { params?: unknown }, extra?: SamplingRequestExtra) => Promise<never>,
  ): void
}

/**
 * Read the progress token the REQUESTER minted, if it minted one.
 *
 * We are the client answering a server-initiated request, so we never choose this
 * value. The SDK's requester side writes it only when its caller asked for
 * progress (`shared/protocol.js`: `if (options?.onprogress) { ... _meta: { ...,
 * progressToken: messageId } }`) and the responder side hands the handler that
 * same object (`_meta: request.params?._meta`). NO TOKEN THEREFORE MEANS THE
 * SERVER DID NOT ASK FOR PROGRESS, and we must send nothing at all — an
 * unsolicited notification hits `_onprogress`'s "unknown token" branch and is
 * reported to the peer as an error.
 */
function progressTokenOf(extra: SamplingRequestExtra | undefined) {
  const meta = extra?._meta
  if (typeof meta !== "object" || meta === null) return undefined
  const token = (meta as { progressToken?: unknown }).progressToken
  return typeof token === "string" || typeof token === "number" ? token : undefined
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
 *
 * `timeoutMs` bounds the MODEL CALL and defaults to DEFAULT_SAMPLING_TIMEOUT;
 * `approvalTimeoutMs` bounds the APPROVAL WAIT and defaults to
 * DEFAULT_SAMPLING_APPROVAL_TIMEOUT. Production passes neither. Both are
 * parameters so the expiry paths can be driven in a test without waiting minutes
 * — the default values themselves are pinned by assertions on the exported
 * constants.
 *
 * Their sum is also enforced here as an ABSOLUTE CEILING on the whole request, so
 * the stretch of work covered by no phase bound (content conversion, model
 * selection, provider initialisation) cannot run unbounded either. That error
 * names no phase, because by construction it is the one case where we do not know
 * which one to blame.
 */
export function serve(
  server: string,
  client: SamplingClient,
  bridge: Bridge,
  timeoutMs: number = DEFAULT_SAMPLING_TIMEOUT,
  approvalTimeoutMs: number = DEFAULT_SAMPLING_APPROVAL_TIMEOUT,
  livenessIntervalMs: number = DEFAULT_LIVENESS_INTERVAL,
) {
  client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
    const params = (request.params ?? {}) as CreateMessageParams
    // KEEPALIVE WIRING. Both halves come from the SDK and neither is ours to
    // fabricate: the token off the request's `_meta`, the sender off `extra`. If
    // either is missing the server did not ask for progress and `liveness` stays
    // undefined, which makes `handle` emit nothing.
    const progressToken = progressTokenOf(extra)
    const send = extra?.sendNotification
    const liveness: Liveness | undefined =
      progressToken !== undefined && typeof send === "function"
        ? { progressToken, send: send as Liveness["send"], intervalMs: livenessIntervalMs }
        : undefined
    const ceilingMs = timeoutMs + approvalTimeoutMs
    // Effect 4 exposes no `timeoutFail` (it survives only in doc comments), so
    // the deadline is expressed as timeoutOption plus an explicit failure.
    const effect = handle({
      server,
      params,
      sessionID: activeSessions.get(client),
      signal: extra?.signal,
      timeoutMs,
      approvalTimeoutMs,
      liveness,
    }).pipe(
      Effect.timeoutOption(ceilingMs),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(
              new SamplingError(TIMEOUT_CODE, "sampling timed out", {
                server,
                phase: "total",
                timeout: ceilingMs,
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
