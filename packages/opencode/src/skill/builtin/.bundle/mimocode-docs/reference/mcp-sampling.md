# MCP Client-Side Sampling

MiMoCode implements the MCP client `sampling` capability
([spec](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)).
An MCP server can ask MiMoCode to run a model call on its behalf via
`sampling/createMessage`, so **the server never needs its own API key** — it
borrows the model connection the user already configured.

## The motivating use case

The MiMo Cut MCP server extracts a video's audio track to a 16 kHz mono WAV and
needs a transcript. Instead of shipping its own provider credentials, it sends
the WAV to MiMoCode as MCP `AudioContent` and asks for a completion:

```json
{
  "method": "sampling/createMessage",
  "params": {
    "messages": [
      { "role": "user", "content": [
        { "type": "text", "text": "Transcribe this audio verbatim." },
        { "type": "audio", "data": "<base64 wav>", "mimeType": "audio/wav" }
      ]}
    ],
    "systemPrompt": "You are a verbatim transcription engine.",
    "maxTokens": 2048,
    "modelPreferences": { "hints": [{ "name": "mimo-v2.5" }] }
  }
}
```

MiMoCode picks a configured, audio-capable model (preferring the hinted
`mimo-v2.5`), asks the user to approve, runs the call, and returns the model's
text unchanged. `MIMO_API_KEY` is never read or needed by the server.

## Capability negotiation

MiMoCode declares `capabilities.sampling = {}` during `initialize`.

`sampling.tools` and `sampling.context` are deliberately **not** declared,
because they are not implemented. Per the spec a client must error when a server
sends `tools`/`toolChoice` without the `sampling.tools` declaration, and
MiMoCode does exactly that. `includeContext` defaults to `none`: MiMoCode never
ships your session history to an MCP server.

## Model selection

MCP publishes no model list and no modality discovery, so selection is driven by
the **Model Capability Registry** (`src/provider/capability-registry.ts`). The
order is **filter, then rank** — and never the other way round:

1. **Derive** the required modalities from the actual content (text / image /
   audio, plus each item's MIME type and decoded byte size).
2. **Filter** to models that are *both* capability-compatible *and* have
   configured credentials. Compatibility ANDs two gates:
   - the model's own declared input modalities (`capabilities.input.*`, from
     models.dev metadata or your `/modalities` config), and
   - whether the provider adapter behind it can actually serialize that media.
3. **Rank** the survivors using `modelPreferences.hints`, in the server's stated
   order, exact model id first and substring second.
4. If no hint matches an eligible model, fall back to the ordinary model
   selection strategy — but only if its answer is itself eligible.

A hint is a *preference*, never an authorization: it can reorder eligible models
but can never make an ineligible one eligible. A server also cannot supply an
API key, base URL, or any other provider credential.

When nothing is eligible, MiMoCode returns a **structured error** naming every
configured model and why it was rejected. It never drops the audio, never
downgrades it to a text description, and never sends it to a model that cannot
accept it.

### Declared adapter support

Audio support per adapter, and the evidence for each verdict (locked in by
`test/provider/capability-registry-wire.test.ts`, which drives the real adapter
and asserts the serialized request body):

| Adapter | Audio | Accepted MIME | Evidence |
|---|---|---|---|
| `@ai-sdk/openai-compatible` | supported | `audio/wav`, `audio/mp3`, `audio/mpeg` | serializes these as `input_audio`; `audio/flac` and `audio/ogg` throw `functionality not supported` |
| `@ai-sdk/google` | supported | any `audio/*` | passes any audio MIME through as `inlineData` |
| `@ai-sdk/google-vertex` | supported | any `audio/*` | shares the `@ai-sdk/google` content conversion |
| `@ai-sdk/anthropic` | **unsupported** | — | an `audio/wav` part throws `'media type: audio/wav' functionality not supported`, while `image/png` serializes fine |
| `@ai-sdk/google-vertex/anthropic` | **unsupported** | — | shares the `@ai-sdk/anthropic` content conversion |
| `@ai-sdk/amazon-bedrock` | **unsupported** | — | excluded from every audio route in `src/session/tool-attachment.ts` (no direct wire probe) |
| anything else | **unknown** | — | no declaration; support is unproven, not disproven |

`unknown` is a distinct third state on purpose. A provider whose audio support we
cannot substantiate is reported as unproven rather than guessed either way. Both
`unsupported` and `unknown` are ineligible (fail closed), but the error message
distinguishes them so you can tell "this cannot work" from "we do not know".

## Permission model

The default policy is **ask**. The approval prompt shows:

- which MCP server asked,
- the model that will actually run,
- the content types present, and the size of any audio,
- previews of the system prompt and the user text prompt.

Two independent controls:

- `permission.mcp_sampling` — standard permission rule, keyed by MCP server name
  (`{ "*": "ask", "mimo-cut": "allow" }`).
- `mcp.<server>.sampling` — per-server policy: `deny` | `ask` | `allow`
  (default `ask`).

`deny` refuses before any prompt, model selection, or provider call. `allow`
skips the prompt but is **not** a bypass: request size caps, the request
timeout, and model capability checks all still apply.

If a sampling request arrives while no turn is in flight for that server, the
`ask` policy fails closed rather than raising a prompt no UI is listening to.

## Limits

| Limit | Value |
|---|---|
| Media (image/audio) per item, decoded | 20 MiB |
| Text per item, and `systemPrompt` | 1 MiB |
| Whole request, including the approval wait | 120 s |

The media cap is a **client-side safety limit**, not a claim about any
provider's real limit. It exists so a buggy or hostile server cannot push an
unbounded payload through the sampling path. For scale: 30 s of 16 kHz mono
16-bit PCM WAV is about 0.92 MiB.

## Concurrency, cancellation and cleanup

A sampling request normally arrives **while MiMoCode is still waiting for that
same server's `tools/call` to return**. This does not deadlock, for two
independent reasons:

1. The MCP SDK dispatches inbound requests from the transport's `onmessage`
   without awaiting the handler, so serving a sampling request never blocks the
   read loop that must later deliver the tool result.
2. MiMoCode runs the work on a fresh root Effect fiber, which shares no fiber,
   lock, or scope with the fiber parked on `callTool`.

Requests are served concurrently. A cancelled request unwinds through the
handler's abort signal, which is threaded into both the approval wait and the
provider call. Closing or replacing a client interrupts any sampling still in
flight for it, so an orphaned model call cannot outlive its transport.

> **Upstream caveat.** In `@modelcontextprotocol/sdk` 1.27.1 a cancellation whose
> JSON-RPC `requestId` is `0` is silently dropped
> (`if (!notification.params.requestId) return` in `shared/protocol.js`), because
> `0` is falsy. The *first* server-initiated request on a connection is therefore
> uncancellable upstream; later ones cancel correctly. The 120 s request timeout
> is the backstop that keeps even that case from leaking.
>
> MiMoCode does not work around this, because it cannot: the id at risk belongs to
> the **server's** outgoing request counter, which only the server can advance.
> Spending an id from the client side — a ping at connection setup, say — advances
> the client's own counter and leaves the server's at `0`, so the server's
> cancellations still do not land. Measured, together with the failing and working
> cases, in `test/mcp/sampling-e2e.test.ts`; those tests fail if an SDK upgrade
> changes this behaviour.
>
> The residual, stated plainly: **when a server abandons the first sampling request
> it issues on a connection, MiMoCode does not learn of it and keeps the model call
> running until the 120 s timeout reaps it.** That timeout is the only bound.

## Security boundaries

- API keys, `Authorization` headers, and provider configuration never appear in a
  sampling response, in logs, or in any error payload.
- Logs record only the server, model, content types, sizes, duration, and result
  status. Never the audio bytes, and never a full prompt — prompt previews are
  whitespace-collapsed and truncated.
- The model's text is returned **verbatim**. MiMoCode does not summarise or
  rewrite it.
- Session context is never forwarded to an MCP server.

## Result and error mapping

Success returns the spec's `CreateMessageResult`: `role`, `content`, `model` (the
model actually used, as `provider/model`), and `stopReason`
(`endTurn` / `stopSequence` / `maxTokens`).

| Situation | JSON-RPC code |
|---|---|
| Malformed params, bad base64/MIME, oversize, no compatible model | `-32602` InvalidParams |
| Policy `deny`, user declined, no session for an `ask` | `-1` |
| Cancelled or timed out | `-32001` |
| Provider failure, model init failure | `-32603` InternalError |
