import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime, Effect } from "effect"
import { ActorRegistry } from "../../src/actor/registry"
import { deriveLiveness, DEFAULT_LIVENESS_STALL_MS, DEFAULT_LIVENESS_ABANDON_MS } from "../../src/actor/schema"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const testLayer = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

async function withRegistry(
  directory: string,
  fn: (rt: ManagedRuntime.ManagedRuntime<Session.Service | ActorRegistry.Service | Bus.Service, never>) => Promise<void>,
) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(testLayer)
      try {
        await fn(rt)
      } finally {
        await rt.dispose()
      }
    },
  })
}

// Pure-derivation table: deriveLiveness maps honest registry fields to the
// pull-side signal. No I/O — this pins the rule + threshold exactly.
describe("deriveLiveness (T39 derivation rule)", () => {
  const now = 1_000_000

  test("running + recent turn (within window) → progressing", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastTurnTime: now - 1_000,
          turnCount: 1,
          time: { created: now - 2_000, updated: now - 1_000 },
        },
        now,
      ),
    ).toBe("progressing")
  })

  test("running + turn older than the window → stalled", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastTurnTime: now - (DEFAULT_LIVENESS_STALL_MS + 1),
          turnCount: 1,
          time: { created: now - (DEFAULT_LIVENESS_STALL_MS + 2), updated: now },
        },
        now,
      ),
    ).toBe("stalled")
  })

  test("not-yet-started child (turnCount 0) is never stalled — slow first turn is not a stall", () => {
    // last_turn_time is the spawn time; even far outside the window a child that
    // has not completed a turn (queued behind the concurrency gate / cold-start)
    // must read progressing, not stalled.
    expect(
      deriveLiveness(
        {
          status: "pending",
          lastOutcome: undefined,
          lastTurnTime: now - 10 * 60_000,
          turnCount: 0,
          time: { created: now - 10 * 60_000, updated: now - 10 * 60_000 },
        },
        now,
      ),
    ).toBe("progressing")
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastTurnTime: now - 10 * 60_000,
          turnCount: 0,
          time: { created: now - 10 * 60_000, updated: now - 10 * 60_000 },
        },
        now,
      ),
    ).toBe("progressing")
  })

  test("pending is treated as live and split by the same window (once it has run a turn)", () => {
    expect(
      deriveLiveness(
        { status: "pending", lastOutcome: undefined, lastTurnTime: now, turnCount: 1, time: { created: now, updated: now } },
        now,
      ),
    ).toBe("progressing")
    expect(
      deriveLiveness(
        {
          status: "pending",
          lastOutcome: undefined,
          lastTurnTime: now - 10 * 60_000,
          turnCount: 1,
          time: { created: now - 11 * 60_000, updated: now - 10 * 60_000 },
        },
        now,
      ),
    ).toBe("stalled")
  })

  test("exactly at the threshold boundary is still progressing (<= window)", () => {
    expect(
      deriveLiveness(
        {
          status: "running",
          lastOutcome: undefined,
          lastTurnTime: now - DEFAULT_LIVENESS_STALL_MS,
          turnCount: 1,
          time: { created: now - DEFAULT_LIVENESS_STALL_MS - 1, updated: now },
        },
        now,
      ),
    ).toBe("progressing")
  })

  test("custom stallMs overrides the default window", () => {
    // 5s-old turn: stalled under a 1s window, progressing under a 60s window.
    const wedged = {
      status: "running" as const,
      lastOutcome: undefined,
      lastTurnTime: now - 5_000,
      turnCount: 1,
      time: { created: now - 6_000, updated: now - 5_000 },
    }
    expect(deriveLiveness(wedged, now, 1_000)).toBe("stalled")
    expect(deriveLiveness(wedged, now, 60_000)).toBe("progressing")
  })

  test("terminal outcomes come straight from lastOutcome regardless of turn age", () => {
    const terminal = { status: "idle" as const, lastTurnTime: 0, turnCount: 1, time: { created: 0, updated: 0 } }
    expect(deriveLiveness({ ...terminal, lastOutcome: "success" }, now)).toBe("success")
    expect(deriveLiveness({ ...terminal, lastOutcome: "failure" }, now)).toBe("failure")
    expect(deriveLiveness({ ...terminal, lastOutcome: "cancelled" }, now)).toBe("cancelled")
  })

  test("idle with no outcome → idle", () => {
    expect(
      deriveLiveness(
        { status: "idle", lastOutcome: undefined, lastTurnTime: 0, turnCount: 0, time: { created: 0, updated: 0 } },
        now,
      ),
    ).toBe("idle")
  })

  // === Defect B: the turnCount-0 leniency is bounded, not unbounded ===
  // A child that died BEFORE its first turn used to read `progressing` forever,
  // because `turnCount === 0` returned early and skipped every staleness check.
  // The leniency is still there — it is now measured from spawn time and capped
  // by DEFAULT_LIVENESS_ABANDON_MS.
  test("never-started child spawned long ago does NOT read progressing", () => {
    const stillborn = {
      status: "pending" as const,
      lastOutcome: undefined,
      lastTurnTime: now - 24 * 60 * 60_000,
      turnCount: 0,
      time: { created: now - 24 * 60 * 60_000, updated: now - 24 * 60 * 60_000 },
    }
    expect(deriveLiveness(stillborn, now)).not.toBe("progressing")
    expect(deriveLiveness(stillborn, now)).toBe("idle")
    expect(deriveLiveness({ ...stillborn, status: "running" }, now)).toBe("idle")
  })

  test("the turnCount-0 leniency still holds inside the abandonment bound", () => {
    // Just under the bound: a queued / cold-starting first turn is still progress.
    const created = now - (DEFAULT_LIVENESS_ABANDON_MS - 1)
    expect(
      deriveLiveness(
        { status: "pending", lastOutcome: undefined, lastTurnTime: created, turnCount: 0, time: { created, updated: created } },
        now,
      ),
    ).toBe("progressing")
    // Exactly at the bound is still lenient (> abandonMs, same <= convention as stallMs).
    const atBound = now - DEFAULT_LIVENESS_ABANDON_MS
    expect(
      deriveLiveness(
        { status: "pending", lastOutcome: undefined, lastTurnTime: atBound, turnCount: 0, time: { created: atBound, updated: atBound } },
        now,
      ),
    ).toBe("progressing")
  })

  // === Defect A (read side): a row whose process is gone is not routable ===
  // ActorRegistry's orphan sweep is the only repair for a row whose owner died,
  // and it runs once at process init for rows of a different instance. Until then
  // the row keeps claiming running/pending, and both `progressing` and `stalled`
  // are presented to the orchestrator as "in progress" — routable, and implying
  // work is already in flight. Past the abandonment bound the derivation stops
  // believing the claim.
  test("started child still claiming running long after its last turn is not routable", () => {
    // The measured fixture: peer "Fix calc.py add() bug", turnCount 26, replayed
    // a day after its last turn.
    const dead = {
      status: "running" as const,
      lastOutcome: undefined,
      lastTurnTime: now - 24 * 60 * 60_000,
      turnCount: 26,
      time: { created: now - 25 * 60 * 60_000, updated: now - 24 * 60 * 60_000 },
    }
    const live = deriveLiveness(dead, now)
    expect(live).not.toBe("stalled")
    expect(live).not.toBe("progressing")
    expect(live).toBe("idle")
  })

  test("custom abandonMs overrides the default bound", () => {
    const row = {
      status: "running" as const,
      lastOutcome: undefined,
      lastTurnTime: now - 10 * 60_000,
      turnCount: 3,
      time: { created: now - 11 * 60_000, updated: now - 10 * 60_000 },
    }
    // 10m-old turn: stalled under the default 30m bound, abandoned under a 5m one.
    expect(deriveLiveness(row, now)).toBe("stalled")
    expect(deriveLiveness(row, now, DEFAULT_LIVENESS_STALL_MS, 5 * 60_000)).toBe("idle")
  })
})

// Integration: the registry.liveness helper reads a real row and derives the
// signal. A row registered at now, then advanced via updateTurn, reads
// progressing under the default window; the same row reads stalled under a
// tiny window while its lastTurnTime stays put (turnCount unchanged).
describe("ActorRegistry.liveness (T39 integration)", () => {
  const register = (reg: ActorRegistry.Interface, sessionID: SessionID) =>
    reg.register({
      sessionID,
      actorID: sessionID,
      mode: "peer",
      parentActorID: undefined,
      agent: "build",
      description: "work",
      contextMode: "none",
      contextWatermark: undefined,
      background: true,
      lifecycle: "persistent",
    })

  test("running row with an advancing turn reads progressing (default window)", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "running" })))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateTurn(child.id, child.id)))

      const found = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id)))
      expect(found).toBeDefined()
      expect(found!.liveness).toBe("progressing")
      expect(found!.actor.turnCount).toBe(1)
    })
  })

  test("running row whose last turn is old + has run a turn reads stalled", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "running" })))
      // Advance one turn so the row is no longer a not-yet-started child; its
      // last_turn_time now dates from this updateTurn. With a 1ms staleness
      // window and no further advance, elapsed real time flips it to stalled.
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateTurn(child.id, child.id)))

      await new Promise((r) => setTimeout(r, 5))
      const before = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.get(child.id, child.id)))
      const found = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id, 1)))
      expect(found!.liveness).toBe("stalled")
      // turnCount advanced exactly once, then wedged.
      expect(found!.actor.turnCount).toBe(1)
      expect(found!.actor.lastTurnTime).toBe(before!.lastTurnTime)
    })
  })

  test("not-yet-started row (turnCount 0) reads progressing even far past the window", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "running" })))

      // No updateTurn: last_turn_time is the spawn time, turnCount stays 0. Even
      // with a 1ms staleness window (spawn time is now far outside it), a child
      // that has not run once must NOT read stalled — this is the slow-start
      // (queued / cold-start) false-positive guard.
      await new Promise((r) => setTimeout(r, 5))
      const found = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id, 1)))
      expect(found!.actor.turnCount).toBe(0)
      expect(found!.liveness).toBe("progressing")
    })
  })

  test("terminal idle+failure reads failure; idle+success reads success", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const child = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(ActorRegistry.Service.use((reg) => register(reg, child.id)))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "idle", lastOutcome: "failure" })),
      )
      const failed = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id)))
      expect(failed!.liveness).toBe("failure")

      await rt.runPromise(
        ActorRegistry.Service.use((reg) => reg.updateStatus(child.id, child.id, { status: "idle", lastOutcome: "success" })),
      )
      const done = await rt.runPromise(ActorRegistry.Service.use((reg) => reg.liveness(child.id, child.id)))
      expect(done!.liveness).toBe("success")
    })
  })

  test("liveness on an absent actor row returns undefined", async () => {
    await using tmp = await tmpdir({ git: true })
    await withRegistry(tmp.path, async (rt) => {
      const found = await rt.runPromise(
        Effect.gen(function* () {
          const reg = yield* ActorRegistry.Service
          return yield* reg.liveness(SessionID.make("ses_missing"), "ses_missing")
        }),
      )
      expect(found).toBeUndefined()
    })
  })
})
