import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Command } from "../../src/command"
import { GlobalBus } from "../../src/bus/global"
import { Database, desc, eq } from "../../src/storage"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageTable, SessionTable } from "../../src/session/session.sql"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { spawnRef } from "../../src/actor/spawn-ref"
import type { AgentOutcome } from "../../src/actor/spawn"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("alibaba"),
  modelID: ModelID.make("qwen-plus"),
}

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

/** OpenAI-compatible SSE for a plain text stop response. */
function chat(text: string): ReadableStream<Uint8Array> {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(payload))
      ctrl.close()
    },
  })
}

/** Start a Bun HTTP mock that streams `reply` for every /chat/completions call. */
function startLLM(reply: string) {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      calls++
      return new Response(chat(reply), { status: 200, headers: { "Content-Type": "text/event-stream" } })
    },
  })
  return {
    origin: server.url.origin,
    get calls() {
      return calls
    },
    stop: () => server.stop(true),
  }
}

// ---- spawnRef seam control ----------------------------------------------
// tryStartCheckpointWriter resolves the checkpoint-writer subagent through the
// process-wide spawnRef.current seam (late-bound to break an Actor↔SessionPrompt
// layer cycle). Because it is a module global, its value leaks across tests in
// the same process, so each case-2 test sets it explicitly (and restores it)
// rather than depending on ambient state.
type SpawnImpl = NonNullable<typeof spawnRef.current>

function withSpawnRef<T>(impl: SpawnImpl | undefined, body: () => Promise<T>): Promise<T> {
  const prev = spawnRef.current
  spawnRef.current = impl
  return body().finally(() => {
    spawnRef.current = prev
  })
}

// A spawn stub emulating a successful checkpoint-writer run: on spawn it writes
// a real (non-template) checkpoint file for the PARENT session, then resolves
// the outcome to success. This drives the real case-2 path end-to-end
// (hasCheckpoint=false → tryStartCheckpointWriter → waitForWriter → success →
// rebuildFromCheckpoint) without a slow real LLM writer round-trip.
//
// The parent's checkpoint watermark (last_checkpoint_message_id) is what
// rebuildFromCheckpoint's lastBoundary reads. In production the writer runs for
// tens of seconds, so tryStartCheckpointWriter's settlement fiber advances the
// watermark long before waitForWriter returns. This stub is near-instant, so it
// advances the watermark itself to the session's last message — matching what a
// real settled writer leaves behind — rather than racing the settlement fiber.
function writerThatWritesCheckpoint(marker: string): SpawnImpl {
  let counter = 0
  return {
    spawn: (input) =>
      Effect.gen(function* () {
        counter += 1
        const parent = (input.parentSessionID ?? input.sessionID) as SessionID
        const outcome = yield* Deferred.make<AgentOutcome>()
        const cpFile = checkpointPath(parent)
        yield* Effect.promise(() => fs.mkdir(path.dirname(cpFile), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(cpFile, `# Session checkpoint\n\n## §1 Active intent\n${marker}\n`),
        )
        // Advance the watermark to the newest message, as a settled writer does.
        const last = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select({ id: MessageTable.id })
              .from(MessageTable)
              .where(eq(MessageTable.session_id, parent))
              .orderBy(desc(MessageTable.id))
              .limit(1)
              .get(),
          ),
        )
        if (last?.id) {
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .update(SessionTable)
                .set({ last_checkpoint_message_id: last.id })
                .where(eq(SessionTable.id, parent))
                .run(),
            ),
          )
        }
        yield* Deferred.succeed(outcome, { status: "success" as const })
        return { actorID: `${input.agentType}-${counter}`, sessionID: input.sessionID, outcome }
      }),
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(undefined),
  } as SpawnImpl
}

function mimocodeConfig(baseURL: string) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["alibaba"],
    provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${baseURL}/v1` } } },
    agent: { build: { model: "alibaba/qwen-plus" } },
  })
}

async function seedUserMessage(sessionID: SessionID, text: string) {
  const msg = await Effect.runPromise(
    Session.Service.use((s) =>
      s.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      }),
    ).pipe(Effect.provide(Session.defaultLayer)),
  )
  await Effect.runPromise(
    Session.Service.use((s) =>
      s.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
      }),
    ).pipe(Effect.provide(Session.defaultLayer)),
  )
  return msg
}

// These tests drive the REAL /rebuild handler in SessionPrompt.command (the
// same code path a user hits by running `/rebuild`) against a scripted LLM
// stub, and assert on observable runtime behavior — inserted boundary
// messages, the returned message, whether the model was called, and the busy
// status events published on the Bus. They intentionally avoid grepping
// prompt.ts source text (which verifies nothing and breaks on refactors) per
// AGENTS.md: "Test actual implementation, do not duplicate logic into tests".
describe("Manual /rebuild: on-the-spot rebuild driven through SessionPrompt.command", () => {
  test(
    "case 1: checkpoint on disk + no writer → handler inserts a boundary and enters the runLoop",
    async () => {
      const llm = startLLM("rebuilt-reply-from-model")
      try {
        await using tmp = await tmpdir({
          git: true,
          init: (dir) => Bun.write(path.join(dir, "mimocode.json"), mimocodeConfig(llm.origin)),
        })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const prompt = yield* SessionPrompt.Service
                const sessions = yield* Session.Service
                const info = yield* sessions.create({ title: "rebuild-case-1" })

                yield* Effect.promise(() => seedUserMessage(info.id, "turn one"))
                yield* Effect.promise(() => seedUserMessage(info.id, "turn two"))
                const boundaryMsg = yield* Effect.promise(() => seedUserMessage(info.id, "turn three"))

                // Real (non-template) checkpoint on disk so renderRebuildContext
                // produces non-empty content and the boundary can be inserted.
                const cpFile = checkpointPath(info.id)
                yield* Effect.promise(() => fs.mkdir(path.dirname(cpFile), { recursive: true }))
                yield* Effect.promise(() =>
                  fs.writeFile(
                    cpFile,
                    "# Session checkpoint\n\n## §1 Active intent\nRebuild the context from this checkpoint.\n",
                  ),
                )

                // Seed the checkpoint watermark the same way a settled writer does
                // (SessionTable.last_checkpoint_message_id) so lastBoundary resolves
                // and the handler takes the has-checkpoint → rebuild path.
                yield* Effect.sync(() =>
                  Database.use((db) =>
                    db
                      .update(SessionTable)
                      .set({ last_checkpoint_message_id: boundaryMsg.id })
                      .where(eq(SessionTable.id, info.id))
                      .run(),
                  ),
                )

                const before = yield* sessions.messages({ sessionID: info.id })
                const userCountBefore = before.filter((m) => m.info.role === "user").length

                // Drive the real handler.
                const result = yield* prompt.command({
                  sessionID: info.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })

                // A MANUAL /rebuild must NOT enter the runLoop: it inserts the
                // boundary and returns the synthetic note WITHOUT producing a
                // model reply (the user asked no question). So the returned
                // message is the synthetic rebuild note (role "user", not an
                // assistant turn), and the LLM was never called — no spurious
                // "reply to nothing" turn.
                expect(result.info.role).not.toBe("assistant")
                expect(
                  result.parts.some(
                    (p) => p.type === "text" && p.text.includes("Context rebuilt from the latest checkpoint"),
                  ),
                ).toBe(true)
                expect(
                  result.parts.some((p) => p.type === "text" && p.text.includes("rebuilt-reply-from-model")),
                ).toBe(false)
                expect(llm.calls).toBe(0)

                // And no assistant reply carrying the scripted text landed in the DB.
                const replied = (yield* sessions.messages({ sessionID: info.id })).some((m) =>
                  m.parts.some((p) => p.type === "text" && p.text.includes("rebuilt-reply-from-model")),
                )
                expect(replied).toBe(false)

                // A checkpoint boundary message was actually inserted into the DB.
                const after = yield* sessions.messages({ sessionID: info.id })
                const boundaries = after.filter((m) => m.parts.some((p) => p.type === "checkpoint"))
                expect(boundaries.length).toBe(1)

                // The rebuild-success synthetic prose is present on the boundary run.
                const rebuiltNote = after.some((m) =>
                  m.parts.some(
                    (p) => p.type === "text" && p.text.includes("Context rebuilt from the latest checkpoint"),
                  ),
                )
                expect(rebuiltNote).toBe(true)

                // Original conversation preserved (3 seeded users still there).
                const userCountAfter = after.filter((m) => m.info.role === "user").length
                expect(userCountAfter).toBeGreaterThanOrEqual(userCountBefore)
              }),
            ),
        })
      } finally {
        await llm.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "case 2: no checkpoint → handler spawns a writer, waits for it, then rebuilds from the fresh checkpoint",
    async () => {
      const llm = startLLM("case2-model-reply")
      // The writer stub writes a real checkpoint on spawn and reports success,
      // exercising the handler's spawn→wait→rebuild path for real.
      const writer = writerThatWritesCheckpoint("CASE2_FRESH_CHECKPOINT_BODY")
      try {
        await using tmp = await tmpdir({
          git: true,
          init: (dir) => Bun.write(path.join(dir, "mimocode.json"), mimocodeConfig(llm.origin)),
        })

        await withSpawnRef(writer, () =>
          Instance.provide({
            directory: tmp.path,
            fn: () =>
              run(
                Effect.gen(function* () {
                  const prompt = yield* SessionPrompt.Service
                  const sessions = yield* Session.Service
                  const info = yield* sessions.create({ title: "rebuild-case-2" })
                  yield* Effect.promise(() => seedUserMessage(info.id, "cold session, no checkpoint yet"))
                  yield* Effect.promise(() => seedUserMessage(info.id, "second turn on the cold session"))

                  // Cold session: no checkpoint file exists up front.
                  const result = yield* prompt.command({
                    sessionID: info.id,
                    command: Command.Default.REBUILD,
                    arguments: "",
                    agent: "build",
                  })

                  // The writer wrote a checkpoint and the handler rebuilt from
                  // it, but a MANUAL /rebuild must NOT reply: it returns the
                  // synthetic rebuild note via noReply and never enters the
                  // runLoop, so the LLM is not called.
                  expect(
                    result.parts.some(
                      (p) => p.type === "text" && p.text.includes("Context rebuilt from the latest checkpoint"),
                    ),
                  ).toBe(true)
                  expect(
                    result.parts.some((p) => p.type === "text" && p.text.includes("case2-model-reply")),
                  ).toBe(false)
                  expect(llm.calls).toBe(0)

                  // A rebuild boundary was inserted from the freshly-written checkpoint.
                  const msgs = yield* sessions.messages({ sessionID: info.id })
                  const boundaries = msgs.filter((m) => m.parts.some((p) => p.type === "checkpoint"))
                  expect(boundaries.length).toBe(1)
                  expect(
                    msgs.some((m) =>
                      m.parts.some(
                        (p) => p.type === "text" && p.text.includes("Context rebuilt from the latest checkpoint"),
                      ),
                    ),
                  ).toBe(true)
                }),
              ),
          }),
        )
      } finally {
        await llm.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "case 2 fallback: no checkpoint + no spawnable writer → surfaces the no-checkpoint message without a model reply",
    async () => {
      const llm = startLLM("should-not-be-used-as-a-reply")
      try {
        await using tmp = await tmpdir({
          git: true,
          init: (dir) => Bun.write(path.join(dir, "mimocode.json"), mimocodeConfig(llm.origin)),
        })

        // Force NO writer: with spawnRef unset, tryStartCheckpointWriter cannot
        // spawn and waitForWriter resolves "no-writer" → the handler must fall
        // through to the no-checkpoint outcome (noReply, no runLoop).
        await withSpawnRef(undefined, () =>
          Instance.provide({
            directory: tmp.path,
            fn: () =>
              run(
                Effect.gen(function* () {
                  const prompt = yield* SessionPrompt.Service
                  const sessions = yield* Session.Service
                  const info = yield* sessions.create({ title: "rebuild-case-2-fallback" })
                  yield* Effect.promise(() => seedUserMessage(info.id, "cold session, no checkpoint yet"))

                  const result = yield* prompt.command({
                    sessionID: info.id,
                    command: Command.Default.REBUILD,
                    arguments: "",
                    agent: "build",
                  })

                  // Handler surfaces the no-checkpoint message to the user…
                  expect(
                    result.parts.some(
                      (p) => p.type === "text" && p.text.includes("No checkpoint is available to rebuild from yet"),
                    ),
                  ).toBe(true)

                  // …and did NOT enter the runLoop (noReply), so no assistant
                  // reply carrying the scripted text was produced.
                  const msgs = yield* sessions.messages({ sessionID: info.id })
                  const modelReplied = msgs.some((m) =>
                    m.parts.some((p) => p.type === "text" && p.text.includes("should-not-be-used-as-a-reply")),
                  )
                  expect(modelReplied).toBe(false)

                  // No rebuild boundary was inserted (nothing usable to rebuild from).
                  const boundaries = msgs.filter((m) => m.parts.some((p) => p.type === "checkpoint"))
                  expect(boundaries.length).toBe(0)
                }),
              ),
          }),
        )
      } finally {
        await llm.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "busy status carries descriptive messages while the handler runs (observed on the Bus, not source text)",
    async () => {
      const llm = startLLM("busy-path-reply")
      const writer = writerThatWritesCheckpoint("BUSY_CHECKPOINT_BODY")
      const seen: Array<string | undefined> = []
      // SessionStatus.set publishes on the instance Bus which also mirrors every
      // event onto the process-wide GlobalBus. Subscribing here captures the
      // real busy-status messages the handler emits, regardless of which Bus
      // layer instance SessionPrompt.defaultLayer wired internally.
      const onEvent = (e: { payload?: { type?: string; properties?: { status?: { type?: string; message?: string } } } }) => {
        if (e?.payload?.type === "session.status" && e.payload.properties?.status?.type === "busy") {
          seen.push(e.payload.properties.status.message)
        }
      }
      GlobalBus.on("event", onEvent)
      try {
        await using tmp = await tmpdir({
          git: true,
          init: (dir) => Bun.write(path.join(dir, "mimocode.json"), mimocodeConfig(llm.origin)),
        })

        await withSpawnRef(writer, () =>
          Instance.provide({
            directory: tmp.path,
            fn: () =>
              run(
                Effect.gen(function* () {
                  const prompt = yield* SessionPrompt.Service
                  const sessions = yield* Session.Service

                  // Cold session → exercises BOTH busy messages: "Rebuilding
                  // context…" (set first) then "Writing checkpoint…" (set while
                  // waiting on the writer that this test provides).
                  const info = yield* sessions.create({ title: "rebuild-busy" })
                  yield* Effect.promise(() => seedUserMessage(info.id, "no checkpoint here either"))
                  yield* Effect.promise(() => seedUserMessage(info.id, "second turn"))

                  yield* prompt.command({
                    sessionID: info.id,
                    command: Command.Default.REBUILD,
                    arguments: "",
                    agent: "build",
                  })
                }),
              ),
          }),
        )
      } finally {
        GlobalBus.off("event", onEvent)
        await llm.stop()
      }

      // The handler set busy with the human-readable messages the TUI shows.
      expect(seen).toContain("Rebuilding context\u2026")
      expect(seen).toContain("Writing checkpoint\u2026")
    },
    { timeout: 30_000 },
  )
})
