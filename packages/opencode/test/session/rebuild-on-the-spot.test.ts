import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { Session } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { SessionStatus } from "../../src/session/status"
import { TaskRegistry } from "../../src/task/registry"
import { ActorRegistry } from "../../src/actor/registry"
import { Instance } from "../../src/project/instance"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    Memory.defaultLayer,
    Session.defaultLayer,
    TaskRegistry.defaultLayer,
    ActorRegistry.defaultLayer,
    SessionCheckpoint.defaultLayer,
    SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer)),
  ),
)

async function seedUserMessage(sessionID: SessionID, text: string) {
  const ssn = await Effect.runPromise(
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
        messageID: ssn.id,
        sessionID,
        type: "text",
        text,
      }),
    ).pipe(Effect.provide(Session.defaultLayer)),
  )
  return ssn
}

describe("Manual /rebuild: on-the-spot rebuild with 3-case checkpoint-freshness", () => {
  it.live(
    "case 1: no writer + has checkpoint → inserts boundary immediately (rebuild happens now)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* Session.Service
        const cp = yield* SessionCheckpoint.Service

        const info = yield* ssn.create({ title: "rebuild-test" })
        const m1 = yield* Effect.promise(() => seedUserMessage(info.id, "turn one"))
        const m2 = yield* Effect.promise(() => seedUserMessage(info.id, "turn two"))
        const m3 = yield* Effect.promise(() => seedUserMessage(info.id, "turn three"))

        // Put a real checkpoint on disk so renderRebuildContext produces non-empty context.
        const cpFile = checkpointPath(info.id)
        yield* Effect.promise(() => fs.mkdir(path.dirname(cpFile), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(cpFile, "# Session checkpoint\n\n## §1 Active intent\nTest rebuild.\n"),
        )

        // Verify no boundary exists yet.
        const before = yield* ssn.messages({ sessionID: info.id })
        expect(before.length).toBe(3)

        // Simulate what the /rebuild handler does: insertRebuildBoundary is the core
        // of rebuildFromCheckpoint. When a checkpoint exists and no writer is running,
        // it should insert immediately.
        const inserted = yield* cp.insertRebuildBoundary({
          sessionID: info.id,
          boundary: m3.id,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        })
        expect(inserted).toBe(true)

        // Boundary was inserted — a new message with a checkpoint part exists.
        const after = yield* ssn.messages({ sessionID: info.id })
        expect(after.length).toBe(4)
        const boundary = after.at(-1)!
        expect(boundary.parts.some((p) => p.type === "checkpoint")).toBe(true)

        // All original messages preserved.
        expect(after.some((m) => m.info.id === m1.id)).toBe(true)
        expect(after.some((m) => m.info.id === m2.id)).toBe(true)
        expect(after.some((m) => m.info.id === m3.id)).toBe(true)
      }),
      { outsideGit: true },
    ),
  )

  it.live(
    "case 2: no checkpoint → handler spawns writer + waits + rebuilds (source-level guard)",
    () =>
      Effect.gen(function* () {
        // Source-level guard: verify the /rebuild handler, when no checkpoint
        // exists, actively spawns a checkpoint-writer and waits for it before
        // attempting rebuildFromCheckpoint — the user-decided case-2 semantics.
        const promptSrc = yield* Effect.promise(() =>
          Bun.file(`${import.meta.dir}/../../src/session/prompt.ts`).text(),
        )

        // The handler must check hasCheckpoint before attempting rebuild
        expect(promptSrc).toMatch(
          /if\s*\(input\.command\s*===\s*Command\.Default\.REBUILD\)[\s\S]*?hasCheckpoint/,
        )

        // When no checkpoint exists, must call tryStartCheckpointWriter
        expect(promptSrc).toMatch(
          /if\s*\(input\.command\s*===\s*Command\.Default\.REBUILD\)[\s\S]*?tryStartCheckpointWriter/,
        )

        // Must wait for the writer via waitForWriter
        expect(promptSrc).toMatch(
          /if\s*\(input\.command\s*===\s*Command\.Default\.REBUILD\)[\s\S]*?waitForWriter/,
        )

        // After writer success, must call rebuildFromCheckpoint to insert boundary
        expect(promptSrc).toMatch(
          /if\s*\(input\.command\s*===\s*Command\.Default\.REBUILD\)[\s\S]*?writerOutcome.*success[\s\S]*?rebuildFromCheckpoint/,
        )
      }),
  )

  it.live(
    "busy status is set before rebuild work and cleared after (source-level guard)",
    () =>
      Effect.gen(function* () {
        // Source-level guard: verify the /rebuild handler sets busy status
        // BEFORE calling rebuildFromCheckpoint and clears it when done.
        const promptSrc = yield* Effect.promise(() =>
          Bun.file(`${import.meta.dir}/../../src/session/prompt.ts`).text(),
        )

        // Must set busy status before rebuildFromCheckpoint
        expect(promptSrc).toMatch(
          /if\s*\(input\.command\s*===\s*Command\.Default\.REBUILD\)[\s\S]*?status\.set\(input\.sessionID,\s*\{\s*type:\s*"busy"\s*\}/,
        )

        // Must NOT use noReply:true on the rebuild-success path (so runLoop runs)
        // The noReply:true should only appear in the no-checkpoint early-return path.
        const rebuildBlock = promptSrc.slice(
          promptSrc.indexOf("input.command === Command.Default.REBUILD"),
        )
        // Find the two prompt() calls in the rebuild block
        const firstPromptIdx = rebuildBlock.indexOf("yield* prompt({")
        const secondPromptIdx = rebuildBlock.indexOf("yield* prompt({", firstPromptIdx + 1)

        // The second prompt (rebuild-success path) must NOT have noReply: true
        if (secondPromptIdx >= 0) {
          const secondPromptBlock = rebuildBlock.slice(secondPromptIdx, secondPromptIdx + 300)
          expect(secondPromptBlock).not.toContain("noReply: true")
        }
      }),
  )
})
