import { describe, expect } from "bun:test"
import { $ } from "bun"
import { Effect, Layer } from "effect"
import { Worktree } from "../../src/worktree"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const it = testEffect(Worktree.defaultLayer.pipe(Layer.provideMerge(CrossSpawnSpawner.defaultLayer)))

describe("Worktree.head / isPristine", () => {
  it.live("head returns the worktree HEAD sha; a fresh worktree is pristine, a dirtied one is not", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const wt = yield* Worktree.Service
          const info = yield* wt.makeWorktreeInfo()
          yield* wt.createFromInfo(info)
          const base = yield* wt.head(info.directory)
          expect(base.length).toBeGreaterThan(0)
          // Untouched worktree -> pristine.
          expect(yield* wt.isPristine(info.directory, base)).toBe(true)
          // Write a file -> no longer pristine.
          yield* Effect.promise(() => Bun.write(`${info.directory}/dirty.txt`, "x"))
          expect(yield* wt.isPristine(info.directory, base)).toBe(false)
          yield* wt.remove({ directory: info.directory })
        }),
      { git: true },
    ),
  )
})

describe("Worktree.setup git identity", () => {
  it.live("pins the parent repo identity into the new worktree's local config", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const wt = yield* Worktree.Service
          const info = yield* wt.makeWorktreeInfo()
          yield* wt.createFromInfo(info)
          // The fixture sets the parent repo's local identity to Test/test@mimocode.test.
          const name = (yield* Effect.promise(() => $`git config user.name`.cwd(info.directory).quiet().text())).trim()
          const email = (
            yield* Effect.promise(() => $`git config user.email`.cwd(info.directory).quiet().text())
          ).trim()
          expect(name).toBe("Test")
          expect(email).toBe("test@mimocode.test")
          yield* wt.remove({ directory: info.directory })
        }),
      { git: true },
    ),
  )

  it.live("falls back to a stable mimocode identity when the parent has none", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // Strip the parent's identity so the fallback path is exercised.
          yield* Effect.promise(() => $`git config --unset user.name`.cwd(dir).quiet().nothrow())
          yield* Effect.promise(() => $`git config --unset user.email`.cwd(dir).quiet().nothrow())
          const wt = yield* Worktree.Service
          const info = yield* wt.makeWorktreeInfo()
          yield* wt.createFromInfo(info)
          const name = (yield* Effect.promise(() => $`git config user.name`.cwd(info.directory).quiet().text())).trim()
          const email = (
            yield* Effect.promise(() => $`git config user.email`.cwd(info.directory).quiet().text())
          ).trim()
          expect(name).toBe("mimocode")
          expect(email).toBe("mimocode@users.noreply.github.com")
          // Sanity: identity is never left empty (the hostname-fallback trigger).
          expect(name.length).toBeGreaterThan(0)
          expect(email.length).toBeGreaterThan(0)
          yield* wt.remove({ directory: info.directory })
        }),
      { git: true },
    ),
  )
})
