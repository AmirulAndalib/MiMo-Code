import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { forwardRef } from "../../src/permission/permission-forward-ref"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

beforeEach(() => {
  forwardRef.parentGrants.clear()
})

const bus = Bus.layer
const env = Layer.mergeAll(Permission.layer.pipe(Layer.provide(bus)), bus, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

// A background subagent's ask that would otherwise fail closed (interactive:false).
function childAsk(patterns: string[], extra?: Partial<Parameters<Permission.Interface["ask"]>[0]>) {
  return {
    permission: "edit" as never,
    patterns,
    always: ["*"],
    metadata: {},
    sessionID: "ses_child" as never,
    ruleset: [],
    tool: { messageID: "msg_test" as never, callID: "call_test" },
    interactive: false as boolean,
    inherit: { parentSessionID: "ses_parent" },
    ...extra,
  }
}

describe("Permission.ask parent-grant inheritance", () => {
  it.live(
    "ordinary background subagent auto-allowed for a dir the parent granted",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        // Parent already holds an "always"-approved grant for /granted/dir.
        forwardRef.setParentGrants("ses_parent", [
          { permission: "edit", pattern: "/granted/dir/*", action: "allow" },
        ])
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        const result = yield* perm.ask(childAsk(["/granted/dir/file.ts"])).pipe(Effect.exit)
        unsub()
        // Auto-allowed: succeeds, no human ask published, nothing left pending.
        expect(result._tag).toBe("Success")
        expect(asked).toBe(0)
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )

  it.live(
    "ordinary background subagent still fails closed for an ungranted dir",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        forwardRef.setParentGrants("ses_parent", [
          { permission: "edit", pattern: "/granted/dir/*", action: "allow" },
        ])
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        const result = yield* perm.ask(childAsk(["/foreign/dir/file.ts"])).pipe(Effect.exit)
        unsub()
        // Not granted by the parent → fail closed (deny), no hang, no ask event.
        expect(result._tag).toBe("Failure")
        expect(asked).toBe(0)
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )

  it.live(
    "no parent snapshot at all -> fails closed (never hangs)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const result = yield* perm.ask(childAsk(["/granted/dir/file.ts"])).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )

  it.live(
    "inherit does NOT override an explicit parent deny",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        forwardRef.setParentGrants("ses_parent", [
          { permission: "edit", pattern: "/granted/*", action: "allow" },
          { permission: "edit", pattern: "/granted/secret/*", action: "deny" },
        ])
        const result = yield* perm.ask(childAsk(["/granted/secret/x.ts"])).pipe(Effect.exit)
        // Parent's own deny wins over its broader allow → child fails closed.
        expect(result._tag).toBe("Failure")
      }),
    ),
  )
})
