import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { Memory } from "../../src/memory"
import { ActorRegistry } from "../../src/actor/registry"
import { Actor, type AgentOutcome } from "../../src/actor/spawn"
import { spawnRef } from "../../src/actor/spawn-ref"
import { TaskRegistry } from "../../src/task/registry"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Actor stub whose outcome Deferred is left unresolved — a writer still
// grinding through LLM round-trips when the caller's bounded wait expires.
// Each spawn's Deferred is captured so a test can settle it LATE, i.e. after
// the caller has already been told "timeout".
const outcomes: Deferred.Deferred<AgentOutcome>[] = []
const hangingActor = Layer.effect(
  Actor.Service,
  Effect.gen(function* () {
    const prevSpawnRef = spawnRef.current
    let counter = 0
    const impl = Actor.Service.of({
      spawn: (input) =>
        Effect.gen(function* () {
          counter += 1
          const outcome = yield* Deferred.make<AgentOutcome>()
          outcomes.push(outcome)
          return { actorID: `${input.agentType}-${counter}`, sessionID: input.sessionID, outcome }
        }),
      cancel: () => Effect.void,
      getForkContext: () => Effect.succeed(undefined),
    })
    spawnRef.current = impl
    yield* Effect.addFinalizer(
      () =>
        Effect.sync(() => {
          if (spawnRef.current === impl) spawnRef.current = prevSpawnRef
        }),
    )
    return impl
  }),
)

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  Memory.defaultLayer,
  TaskRegistry.defaultLayer,
  ActorRegistry.defaultLayer,
  hangingActor,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

// Seed a session with one message and start a writer, returning THIS writer's
// outcome Deferred (located by the array-length delta so concurrent tests never
// settle each other's writer). Resolving that Deferred is how the actor — the
// only thing that knows the writer's real result — reports it, so a late
// resolve models "the writer finally settled, long after the wait bound".
function seedAndStartWriter() {
  return Effect.gen(function* () {
    const svc = yield* SessionCheckpoint.Service
    const ssn = yield* SessionNs.Service
    const info = yield* ssn.create({})
    const user = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: info.id,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID: info.id,
      type: "text",
      text: "seed",
    })
    const idxBefore = outcomes.length
    const started = yield* svc.tryStartCheckpointWriter({
      sessionID: info.id,
      model: { providerID: "test", modelID: "test-model" },
      promptOps: {} as never,
    })
    expect(started).toBe("started")
    return { info, outcome: outcomes[idxBefore]! }
  })
}

// Drive one writer past the 5-minute bound and re-enter the wait exactly the
// way prune's retry watcher does (prune.ts:338-349), then settle the writer
// LATE and return what the re-entered wait reports. This is the seam the
// prune-side tests cannot cover: they stub waitForWriter, so they ASSUME a
// late-settling writer yields "timeout" then its real outcome. Here the real
// service produces it.
function timeoutThenSettle(settled: AgentOutcome) {
  return Effect.gen(function* () {
    const svc = yield* SessionCheckpoint.Service
    const { info, outcome } = yield* seedAndStartWriter()

    // First wait: expires with the writer genuinely still in flight.
    const first = yield* Effect.forkChild(svc.waitForWriter(info.id))
    yield* TestClock.adjust("6 minutes")
    expect(yield* Fiber.join(first)).toBe("timeout")

    // The caller has now been told "timeout" and the writer is still running.
    expect(yield* svc.isWriterRunning(info.id)).toBe(true)

    // Prune re-enters the bounded wait. Advancing the clock (well short of a
    // second bound) both lets the fiber reach Deferred.await and proves it is
    // parked there rather than having returned early: the writers-map entry is
    // still present, because it is only deleted AFTER the writer settles
    // (checkpoint.ts:939).
    const second = yield* Effect.forkChild(svc.waitForWriter(info.id))
    yield* TestClock.adjust("1 minute")
    expect(second.pollUnsafe()).toBeUndefined()

    // The writer finally settles — ~7 minutes in, long past the first bound.
    yield* Deferred.succeed(outcome, settled)
    return yield* Fiber.join(second)
  })
}

describe("SessionCheckpoint.waitForWriter", () => {
  it.effect(
    "in-flight writer past the wait bound reports 'timeout', never 'failure'",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionCheckpoint.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        // Writer needs at least one message to get past the empty-delta guard.
        const user = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: info.id,
          type: "text",
          text: "seed",
        })

        const started = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(started).toBe("started")

        // Pin the BOUND, not just the outcome. At 4 minutes the wait must still
        // be pending: without this, shrinking the bound to (say) 1s would
        // reintroduce the original bug in a new shape — every honest 60-180s
        // writer would report "timeout" — and a lone `adjust("6 minutes")`
        // assertion would still pass.
        const fiber = yield* Effect.forkChild(svc.waitForWriter(info.id))
        yield* TestClock.adjust("4 minutes")
        expect(fiber.pollUnsafe()).toBeUndefined()

        // Now cross the 5-minute bound. The writer's Deferred is still
        // unresolved, so the wait expires while the writer is genuinely in flight.
        yield* TestClock.adjust("2 minutes")
        const result = yield* Fiber.join(fiber)

        // Regression: this used to be "failure", which made the prune retry
        // watcher tick writerFailures and (after MAX_WRITER_FAILURES) trip
        // "gave up after max consecutive failures" — permanently disabling
        // checkpointing for a session whose writers were only slow.
        expect(result).toBe("timeout")

        // The expiry must not have cancelled or retired the writer: it is still
        // in flight and still owns the watermark advance. This is the property
        // that makes "timeout" honest rather than a renamed failure.
        expect(yield* svc.isWriterRunning(info.id)).toBe(true)
      }),
    ),
  )

  // The PR claims the writer's REAL outcome is still booked after the bound
  // expires. Booking happens in prune, whose counter is closure-private — but
  // prune learns the outcome from exactly one place, waitForWriter's return on
  // the re-entered wait, and that IS public. These two cases pin it for both
  // terminal states.
  it.effect(
    "a writer that SUCCEEDS after the bound reports 'success' to the re-entered wait",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const late = yield* timeoutThenSettle({ status: "success" } as AgentOutcome)

        // Not "timeout" and not "no-writer": the late success survives the
        // expiry, which is what lets prune clear writerFailures instead of
        // leaving a healthy-but-slow session stuck near the failure cap.
        expect(late).toBe("success")
      }),
    ),
  )

  it.effect(
    "a writer that FAILS after the bound reports 'failure' to the re-entered wait",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const late = yield* timeoutThenSettle({ status: "failure", error: "boom" })

        // This is the direction that keeps the failure cap reachable in the slow
        // regime: if the late failure were lost (returning "timeout" forever, or
        // "no-writer" because the settle watcher had already removed the map
        // entry), a permanently broken slow writer would never be counted.
        expect(late).toBe("failure")
      }),
    ),
  )
})
