import { Effect, Cause, Exit, Fiber, Option } from "effect"
import { streamText, type ModelMessage } from "ai"
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
 * THIS IS NO LONGER THE PRIMARY DEFENCE AGAINST A HUNG PROVIDER, and that is the
 * most important thing to know about it. The model call streams, so "nothing has
 * arrived for a while" is now directly observable and
 * DEFAULT_SAMPLING_STALL_TIMEOUT acts on it. A hang trips the stall bound, which
 * says so; this bound is what remains for the case a stall detector cannot see:
 * a stream that keeps producing just often enough never to look stalled and yet
 * never finishes. It is a BACKSTOP against pathological-but-alive output, not the
 * thing standing between a dead provider and forever.
 *
 * WHERE 120 s COMES FROM: still nowhere. No derivation and no measurement is
 * recorded for it, here or anywhere else in the repo, and switching to streaming
 * did not produce one — it only demoted what the number is responsible for. The
 * value is deliberately left ALONE rather than widened to suit its narrower role,
 * because any new number would be exactly as unargued as this one; note that a
 * backstop against a slow-but-live stream plausibly wants a LOOSER value than a
 * primary guard did, so "is 120 s still the right size for this job" is now part
 * of the same open question rather than a settled point. The one thing that IS
 * known about it remains a hazard, not a justification: it is 2x the MCP SDK's
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

/**
 * How long the model may produce NOTHING before we call it stalled.
 *
 * This is the primary hang detector, and it exists because the call streams. A
 * non-streaming call is opaque: the only question you can ask is "has the whole
 * thing taken too long", which is why a total bound had to carry that job and why
 * the number carrying it (DEFAULT_SAMPLING_TIMEOUT) had to be guessed. With a
 * stream the useful question becomes answerable from evidence instead — no bytes
 * for this long is not a policy choice about how patient we are, it is a symptom.
 *
 * The clock covers BOTH the wait for the first chunk and every gap between later
 * chunks, because "no output at all" is the same symptom in both places. Every
 * arriving chunk resets it.
 *
 * THIS NUMBER IS A DEFAULT AWAITING A REAL PRODUCT DECISION, NOT A DERIVED VALUE.
 * Nothing here measures the slowest legitimate gap a real provider produces, so
 * 45 s is not that. It satisfies one mechanical constraint and no more: it is 3x
 * DEFAULT_LIVENESS_INTERVAL, so at least two liveness notifications reach a peer
 * before we declare a stall, and the peer therefore never learns of the stall
 * from silence. ⚠️THE KNOWN RISK IS A FALSE POSITIVE, and it is not hypothetical:
 * a reasoning model on a large multimodal prompt can spend a long time before its
 * first token, and if that quiet period exceeds this bound we will report a stall
 * for a call that was working. Whether 45 s clears the slowest legitimate
 * time-to-first-token is UNDECIDED — it is unmeasured here. Overridable through
 * `serve`'s parameter, exactly as the other bounds are.
 */
export const DEFAULT_SAMPLING_STALL_TIMEOUT = 45_000

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
 * Stream parts that are the SDK's own bookkeeping rather than model output.
 *
 * MEASURED, NOT ASSUMED, and the measurement overturned the obvious guess. Against
 * a provider whose HTTP call never answers at all, `fullStream` still yields
 * `start` immediately (and `abort` at the end). So "every part proves the provider
 * is alive" is false: counting parts indiscriminately made a stone-dead provider
 * report `1 chunk`, which destroys the single distinction this signal exists to
 * draw — never started versus started and went quiet. Only parts OUTSIDE this set
 * advance the activity record, so `chunks === 0` means exactly what it says.
 *
 * The terminal markers are excluded for the same reason and cost nothing: they
 * arrive when the stream is already ending, so they could not have rescued a call
 * from a stall verdict anyway.
 */
const LIFECYCLE_PARTS = new Set(["start", "start-step", "finish-step", "finish", "abort", "error"])

/**
 * What the model call has actually produced so far, written by the stream loop in
 * `handle` and read by the two watchers below. Mutable on purpose: it is the one
 * piece of shared state that makes "is it hung?" answerable rather than guessed.
 *
 * `characters` is a COUNT, never the text — see `heartbeat` for why the text
 * itself does not leave this process on the progress channel.
 */
interface StreamActivity {
  /** Epoch ms of the last chunk, or of the call starting if none has arrived. */
  lastAt: number
  /** Chunks of model output seen. 0 means the provider has produced nothing. */
  chunks: number
  /** Characters of model text seen. */
  characters: number
}

/**
 * LIVENESS FROM REAL EVIDENCE — and what is deliberately NOT sent.
 *
 * The model call streams (`streamText`), so unlike the previous fixed tick this
 * notification reports something observed: how many chunks the provider has
 * actually produced. That upgrade matters because the two failures a peer most
 * needs to tell apart are "our process died" and "the provider went quiet", and a
 * tick that increments on a local timer cannot distinguish them — it keeps
 * arriving, unchanged, while the provider produces nothing forever. A peer can now
 * see the difference, including the specific case of a call that never started at
 * all, which gets its own wording.
 *
 * WHY THE MODEL'S TEXT IS NOT IN `message`, even though we now have it. Three
 * reasons, and the middle one is the one that decided it.
 *   1. CHATTINESS. Deltas arrive far faster than this interval; forwarding each
 *      would turn a keepalive into a second, unasked-for output stream. What goes
 *      out is coalesced to one notification per interval no matter the delta rate.
 *   2. IT WOULD DELIVER OUTPUT THAT A FAILED REQUEST NEVER DELIVERS. The response
 *      contract is a single `CreateMessageResult`: if this request later stalls,
 *      times out or is cancelled, the server is told it failed and receives NO
 *      text. Streaming partial content on the progress channel would hand it a
 *      prefix of an answer the contract says it never got — a disclosure that
 *      exists only in the failure case, which is the worst place to invent one.
 *   3. A SERVER THAT ASKED FOR PROGRESS DID NOT ASK FOR CONTENT. `onprogress` is
 *      how a peer says "tell me you are alive"; MCP has no partial-result channel,
 *      and reading `message` as one would be us deciding on the peer's behalf.
 * What IS disclosed is the running length. That is metadata, not content, and the
 * server learns the exact length seconds later from the result anyway — but it is
 * a real if small disclosure and is named here rather than glossed over.
 *
 * `progress` stays a monotonic TICK, not the chunk count: the spec asks only that
 * the value increase, and a chunk count does not increase during exactly the quiet
 * stretch a peer most needs a notification for. `total` IS STILL OMITTED, because
 * streaming does not tell us how many chunks are coming either — a fraction is
 * still not computable, so none is implied.
 *
 * Runs forever and never fails: each send is ignored, because a peer that cannot
 * receive a notification must not thereby kill the model call. Raced against the
 * model call with `raceFirst` — the model settling first (success OR failure)
 * interrupts this.
 */
function heartbeat(liveness: Liveness, activity: StreamActivity): Effect.Effect<never> {
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
                message:
                  activity.chunks === 0
                    ? "sampling: model call in flight, no output yet"
                    : `sampling: model streaming, ${activity.chunks} chunks / ${activity.characters} characters so far`,
              },
            }),
          catch: (error) => error,
        }).pipe(Effect.ignore),
      ),
    ),
  )
}

/**
 * THE STALL DETECTOR — the primary defence, and the reason a total bound no longer
 * has to be one.
 *
 * Fails as soon as `stallMs` has passed with no chunk arriving. Unlike the total
 * bound this is a claim about the provider rather than about our patience: the
 * stream stopped, and that is a fact we watched happen instead of a deadline we
 * picked. Raced against the model call with `raceFirst`, so this failure
 * interrupts the call fiber, which aborts the provider through the signal
 * composed in `handle`.
 *
 * NOT gated on the peer having asked for progress. The heartbeat is (an
 * unsolicited notification is an error on the peer's side); detecting our own
 * stalled provider is not the peer's business and happens regardless.
 *
 * Polling rather than a per-chunk timer, because the chunk loop lives inside a
 * promise and this has to observe it from outside without restructuring it. The
 * poll interval only bounds detection LATENCY, never correctness: a stall is
 * reported at most one poll late, never early, since the comparison is against a
 * timestamp the loop wrote.
 */
function stallWatch(
  activity: StreamActivity,
  stallMs: number,
  onStalled: () => SamplingError,
): Effect.Effect<never, SamplingError> {
  const poll = Math.max(25, Math.min(250, Math.floor(stallMs / 4)))
  return Effect.forever(
    Effect.sleep(poll).pipe(
      Effect.flatMap(() => (Date.now() - activity.lastAt >= stallMs ? Effect.fail(onStalled()) : Effect.void)),
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
   * How long the model may produce nothing before the call is declared stalled.
   * Defaults to DEFAULT_SAMPLING_STALL_TIMEOUT. This is the bound that actually
   * catches a hung provider; `timeoutMs` is the backstop behind it.
   */
  readonly stallTimeoutMs?: number
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
  const stallTimeoutMs = input.stallTimeoutMs ?? DEFAULT_SAMPLING_STALL_TIMEOUT
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

  // Shared with the two watchers raced against the call below. Seeded now, reset
  // when the request is actually issued, and advanced by every chunk.
  const activity: StreamActivity = { lastAt: Date.now(), chunks: 0, characters: 0 }

  const call = Effect.tryPromise({
    try: (fiberSignal: AbortSignal) => {
      // COMPOSE both abort sources. `fiberSignal` is aborted whenever this fiber
      // is interrupted, which covers the model bound below, the stall detector,
      // the absolute ceiling in `serve` and `cancelAll`; on its own, none of those
      // reaches the provider, because interrupting a fiber does not cancel a
      // promise already in flight inside it. `input.signal` is the MCP SDK's
      // per-request signal and covers a server-issued cancellation. Either one
      // must stop the HTTP call, so the provider gets the union of the two, not
      // just one of them.
      providerSignal = input.signal ? AbortSignal.any([fiberSignal, input.signal]) : fiberSignal
      const stream = streamText({
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
        // `streamText` reports provider failures as an `error` PART rather than by
        // rejecting, and its default handler logs them. The loop below rethrows
        // that part, which is what puts the failure back on the path `catch`
        // already maps, so this handler exists only to stop the duplicate log.
        onError: () => {},
      })
      // WHY THE STREAM IS ASSEMBLED HERE AND NOT RETURNED. The response contract is
      // a single `CreateMessageResult` — `sampling/createMessage` has one reply and
      // JSON-RPC has no streaming response — so streaming is an INTERNAL change:
      // it buys an observable stall signal and real liveness, and changes nothing a
      // server receives. The text is concatenated verbatim in arrival order.
      return (async () => {
        activity.lastAt = Date.now()
        let text = ""
        for await (const part of stream.fullStream) {
          // Same shape as the in-tree consumers (session/goal.ts): an `error` part
          // is the provider failing, so rethrow it and let `catch` classify it
          // exactly as it classified a rejected `generateText`.
          if (part.type === "error") throw part.error
          if (part.type === "text-delta") {
            text += part.text
            activity.characters += part.text.length
          }
          // Only genuine model output counts as life. `start` arrives even from a
          // provider that never answers, so lifecycle parts neither increment the
          // count nor reset the stall clock — see LIFECYCLE_PARTS.
          if (!LIFECYCLE_PARTS.has(part.type)) {
            activity.chunks += 1
            activity.lastAt = Date.now()
          }
        }
        return { text, finishReason: await stream.finishReason }
      })()
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

  // THE STALL DETECTOR, raced first and NOT gated on the peer asking for progress.
  // `raceFirst` is "first to SETTLE", so this failing interrupts the call fiber and
  // aborts the provider; `Effect.race` would be wrong because it waits for a losing
  // side to fail and neither side here obliges.
  const watched = Effect.raceFirst(
    call,
    stallWatch(
      activity,
      stallTimeoutMs,
      () =>
        new SamplingError(TIMEOUT_CODE, "sampling stalled: the model produced no output", {
          server: input.server,
          model: modelRef,
          // A phase of its own, distinct from `"model"`: that one means the whole
          // call outran its budget, this one means output STOPPED, and the two
          // want different responses from a server author.
          phase: "stall",
          timeout: stallTimeoutMs,
          // The observability payoff, and the reason this is not just a shorter
          // timeout: 0 says the provider never produced anything, non-zero says it
          // started and then went quiet.
          chunks: activity.chunks,
          characters: activity.characters,
        }),
    ),
  )

  // KEEPALIVE, and only if the server asked for it. `raceFirst` again, for the same
  // reason: the model call winning with a failure — including a stall — still has
  // to interrupt the heartbeat, which never settles and so can never win.
  const kept = input.liveness ? Effect.raceFirst(watched, heartbeat(input.liveness, activity)) : watched

  const result = yield* kept.pipe(
    // THE MODEL PHASE'S BACKSTOP. Liveness notifications reset the PEER's timer,
    // never this. What reaches this bound now is narrow: a provider that hangs
    // outright trips the stall detector above and reports a stall, so this fires
    // for a stream that keeps trickling without ever finishing.
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
 * DEFAULT_SAMPLING_APPROVAL_TIMEOUT; `stallTimeoutMs` bounds how long the model
 * may produce NOTHING and defaults to DEFAULT_SAMPLING_STALL_TIMEOUT — that last
 * one is what catches a hung provider, with `timeoutMs` behind it as a backstop.
 * Production passes none of them. They are parameters so the expiry paths can be
 * driven in a test without waiting minutes — the default values themselves are
 * pinned by assertions on the exported constants.
 *
 * The sum of the two PHASE bounds is also enforced here as an ABSOLUTE CEILING on
 * the whole request, so the stretch of work covered by no phase bound (content
 * conversion, model selection, provider initialisation) cannot run unbounded
 * either. The stall bound is deliberately NOT part of that sum: it is not a share
 * of the request's budget but a detector operating inside the model phase. That
 * ceiling error names no phase, because by construction it is the one case where
 * we do not know which one to blame.
 */
export function serve(
  server: string,
  client: SamplingClient,
  bridge: Bridge,
  timeoutMs: number = DEFAULT_SAMPLING_TIMEOUT,
  approvalTimeoutMs: number = DEFAULT_SAMPLING_APPROVAL_TIMEOUT,
  livenessIntervalMs: number = DEFAULT_LIVENESS_INTERVAL,
  stallTimeoutMs: number = DEFAULT_SAMPLING_STALL_TIMEOUT,
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
      stallTimeoutMs,
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
