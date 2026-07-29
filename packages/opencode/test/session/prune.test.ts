import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { SessionCheckpoint, type WriterOutcome } from "../../src/session/checkpoint"
import { SessionPrune, defaultThresholdsFor } from "../../src/session/prune"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ActorRegistry } from "../../src/actor/registry"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionPrune.layer.pipe(
    Layer.provide(SessionNs.defaultLayer),
    Layer.provide(SessionCheckpoint.defaultLayer),
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provideMerge(deps),
  ),
)

const it = testEffect(env)

/**
 * Seeds a session that `prune` can act on: one user+assistant turn with a
 * 200k-char tool output, then two follow-up user turns. The 200k output is
 * old enough (separated by later turns) that prune should consider it for
 * trimming, unless the tool name is in the protected list.
 */
const seedSessionWithOldToolOutput = Effect.fn("PruneTest.seed")(function* (input: {
  sessionID: SessionID
  dir: string
  tool: string
}) {
  const ssn = yield* SessionNs.Service

  const user = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: input.sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: input.sessionID,
    type: "text",
    text: "first",
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: input.sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: input.dir, root: input.dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID: user.id,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* ssn.updateMessage(assistant)
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "tool",
    callID: crypto.randomUUID(),
    tool: input.tool,
    state: {
      status: "completed",
      input: {},
      output: "x".repeat(200_000),
      title: "done",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  })
  for (const text of ["second", "third"]) {
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: input.sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: input.sessionID,
      type: "text",
      text,
    })
  }
})

describe("SessionPrune.prune", () => {
  it.live(
    "compacts old completed tool output",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          const info = yield* ssn.create({})

          yield* seedSessionWithOldToolOutput({ sessionID: info.id, dir, tool: "bash" })

          // pressure-based level requires tokens > 0; simulate heavy usage
          const tokens = { input: 80_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          yield* svc.prune({ sessionID: info.id, model, tokens })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type).toBe("tool")
          expect(part?.state.status).toBe("completed")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeNumber()
          }
        }),

      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )

  it.live(
    "skips protected skill tool output",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          const info = yield* ssn.create({})

          yield* seedSessionWithOldToolOutput({ sessionID: info.id, dir, tool: "skill" })

          const tokens = { input: 80_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          yield* svc.prune({ sessionID: info.id, model, tokens })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type).toBe("tool")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeUndefined()
          }
        }),

      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )
})

describe("SessionPrune.fireCheckpoints writer failure is not retried in place", () => {
  // A programmable stub of SessionCheckpoint.Service drives the writer
  // outcomes: tryStartCheckpointWriter always returns "started" (counted in
  // stubEnqueueCount), waitForWriter returns pre-seeded outcomes in order.
  // Each test constructs a fresh harness so module state is per-test.
  function makeRetryHarness() {
    const outcomes: Array<WriterOutcome | "no-writer"> = []
    const state = { enqueueCount: 0 }

    const stubLayer = Layer.succeed(
      SessionCheckpoint.Service,
      SessionCheckpoint.Service.of({
        tryStartCheckpointWriter: () =>
          Effect.sync(() => {
            state.enqueueCount++
            return "started" as const
          }),
        waitForWriter: () => Effect.sync(() => outcomes.shift() ?? ("no-writer" as const)),
        drainWriters: () => Effect.succeed({ drained: 0, timedOut: 0 }),
        hasCheckpoint: () => Effect.succeed(false),
        hasMemoryOrTasks: () => Effect.succeed(false),
        loadLatest: () => Effect.succeed(undefined),
        loadCheckpoints: () => Effect.succeed([]),
        renderIndex: () => Effect.succeed(""),
        renderRebuildContext: () => Effect.succeed(""),
        lastBoundary: () => Effect.succeed(undefined),
        isWriterRunning: () => Effect.succeed(false),
        insertRebuildBoundary: () => Effect.succeed(false),
      }),
    )

    const env = Layer.mergeAll(
      SessionNs.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      SessionPrune.layer.pipe(
        Layer.provide(SessionNs.defaultLayer),
        Layer.provide(stubLayer),
        Layer.provide(ActorRegistry.defaultLayer),
        Layer.provideMerge(deps),
      ),
    )

    return { env, outcomes, state }
  }

  // Helper: run a prune-layer effect inside a tmpdir + Instance context.
  function runWithHarness<A, E>(
    harness: ReturnType<typeof makeRetryHarness>,
    body: Effect.Effect<A, E, SessionPrune.Service | SessionNs.Service>,
    config?: Partial<Config.Info>,
  ): Promise<A> {
    return Effect.runPromise(
      provideTmpdirInstance(() => body, { config }).pipe(Effect.scoped, Effect.provide(harness.env)),
    )
  }

  const makeTokens = () => ({
    input: 60_000,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })

  const makeTokensAt = (n: number) => ({
    input: n,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })

  // These cases replace the six that pinned the deleted accounting
  // (writerFailures / MAX_WRITER_FAILURES / MAX_WRITER_WAIT_EXTENSIONS). What
  // they used to assert, and why it is no longer the requirement:
  //
  //   - "three writer failures retry below cap, stop at cap" and "success
  //     outcome resets failure counter" asserted that a failure BELOW the cap
  //     re-armed the same threshold (enqueue 1->2->3) and that a success
  //     cleared the counter. Both encoded in-place retry as the requirement.
  //   - "a timed-out wait never ticks the counter..." and "a writer that fails
  //     past the wait bound is still counted, so the cap stays reachable"
  //     asserted the watcher kept re-entering the bounded wait so a late
  //     outcome still reached the counter.
  //   - the pair bracketing MAX_WRITER_WAIT_EXTENSIONS pinned the 13-call
  //     boundary of that re-entry loop exactly.
  //
  // None of it is required now, because a failed write is self-healing:
  // ensureCheckpointTemplate only writes when the file is ABSENT and the
  // watermark advances only on success, so a failure leaves file and watermark
  // consistent at the last good checkpoint. The requirement is the inverse --
  // a failure must NOT retry in place, and the next crossing must still fire.
  test("a failed writer does not re-arm its own threshold — no in-place retry", async () => {
    const harness = makeRetryHarness()
    const promptOps = {} as any

    await runWithHarness(
      harness,
      Effect.gen(function* () {
        const svc = yield* SessionPrune.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const model = createModel({ context: 100_000, output: 32_000 })

        harness.outcomes.push("failure")

        // Fire 1 crosses 30K and enqueues; its writer fails.
        yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(35_000), promptOps })
        yield* Effect.sleep(100)
        expect(harness.state.enqueueCount).toBe(1)

        // Fires 2-4 at the same token level must NOT re-enqueue: the threshold
        // stays in `crossed`. The deleted watcher did `crossed.delete()` on a
        // sub-cap failure, so under the old code these three fires would have
        // read 2, then 3, then stopped at the 3-failure cap.
        for (let i = 0; i < 3; i++) {
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(35_000), promptOps })
          yield* Effect.sleep(100)
        }
        expect(harness.state.enqueueCount).toBe(1)
      }),
      { checkpoint: { thresholds: ["30K", "45K"] } },
    )
  })

  test("a failed writer at the max threshold leaves maxThresholdCrossed set", async () => {
    const harness = makeRetryHarness()
    const promptOps = {} as any

    await runWithHarness(
      harness,
      Effect.gen(function* () {
        const svc = yield* SessionPrune.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const model = createModel({ context: 100_000, output: 32_000 })

        harness.outcomes.push("failure", "failure")

        // Cross BOTH thresholds in one fire so the max threshold is crossed and
        // the observed outcome is a failure.
        yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(50_000), promptOps })
        yield* Effect.sleep(150)

        // The old watcher paired `crossed.delete` with `maxCrossed.delete` on a
        // sub-cap failure, which withdrew the already-raised discard+rebuild
        // signal that prompt.ts consumes. Overflow readiness must not depend on
        // whether the checkpoint writer happened to succeed, so the signal
        // stands: under the old code this read false.
        expect(yield* svc.maxThresholdCrossed(info.id)).toBe(true)
      }),
      { checkpoint: { thresholds: ["30K", "45K"] } },
    )
  })

  test("the next threshold crossing still fires after a failure", async () => {
    const harness = makeRetryHarness()
    const promptOps = {} as any

    await runWithHarness(
      harness,
      Effect.gen(function* () {
        const svc = yield* SessionPrune.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const model = createModel({ context: 100_000, output: 32_000 })

        harness.outcomes.push("failure", "failure")

        // 30K crosses and fails.
        yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(35_000), promptOps })
        yield* Effect.sleep(100)
        expect(harness.state.enqueueCount).toBe(1)

        // Tokens grow past 45K: the failure must not have suppressed the
        // session, so this crossing fires. This is the retry the design relies
        // on instead of an in-place one, and it carries fresher context than a
        // re-fire of 30K would have. The old code reached a SECOND enqueue too
        // -- the counter never gated a NEW threshold -- but it reached a THIRD,
        // because the failure had also re-armed 30K. So the exact count, not
        // just "it still fires", is what pins the absence of in-place retry.
        yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(50_000), promptOps })
        yield* Effect.sleep(100)
        expect(harness.state.enqueueCount).toBe(2)
      }),
      { checkpoint: { thresholds: ["30K", "45K"] } },
    )
  })
})

describe("defaultThresholdsFor (Part 2 density)", () => {
  // Constants used in expected outputs; declared once so a typo in any one
  // assertion is caught against a single source.
  const FOUR_AT_20 = ["20%", "40%", "60%", "80%"] as const
  const NINE_AT_10 = [
    "10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%",
  ] as const
  const EIGHTEEN_AT_5 = Array.from({ length: 18 }, (_, i) => `${(i + 1) * 5}%`)

  test("window < 25K returns empty (subsystem disabled)", () => {
    expect(defaultThresholdsFor(0)).toEqual([])
    expect(defaultThresholdsFor(20_000)).toEqual([])
    expect(defaultThresholdsFor(24_999)).toEqual([])
  })

  test("25K ≤ window ≤ 200K uses [20%, 40%, 60%, 80%] (4 triggers @ 20%)", () => {
    expect(defaultThresholdsFor(25_000)).toEqual(FOUR_AT_20)
    expect(defaultThresholdsFor(50_000)).toEqual(FOUR_AT_20)
    expect(defaultThresholdsFor(100_000)).toEqual(FOUR_AT_20)
    expect(defaultThresholdsFor(150_000)).toEqual(FOUR_AT_20)
    expect(defaultThresholdsFor(200_000)).toEqual(FOUR_AT_20)
  })

  test("200K < window ≤ 500K uses 9-tier [10%..90%]", () => {
    expect(defaultThresholdsFor(200_001)).toEqual(NINE_AT_10)
    expect(defaultThresholdsFor(300_000)).toEqual(NINE_AT_10)
    expect(defaultThresholdsFor(400_000)).toEqual(NINE_AT_10)
    expect(defaultThresholdsFor(500_000)).toEqual(NINE_AT_10)
  })

  test("window > 500K uses 18-tier [5%, 10%, ..., 90%]", () => {
    expect(defaultThresholdsFor(500_001)).toEqual(EIGHTEEN_AT_5)
    expect(defaultThresholdsFor(1_000_000)).toEqual(EIGHTEEN_AT_5)
    expect(defaultThresholdsFor(2_000_000)).toEqual(EIGHTEEN_AT_5)
  })

  test("18-tier shape: starts at 5%, ends at 90%, 18 items, monotonic", () => {
    const out = defaultThresholdsFor(1_000_000)
    expect(out.length).toBe(18)
    expect(out[0]).toBe("5%")
    expect(out[8]).toBe("45%") // mid-array spot check (closes a generator-typo gap)
    expect(out[out.length - 1]).toBe("90%")
    const nums = out.map((s) => parseFloat(s.replace("%", "")))
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThan(nums[i - 1])
    }
  })
})
