import z from "zod"
import { SessionID, MessageID } from "@/session/schema"

export const ActorStatus = z.enum(["pending", "running", "idle"])
export type ActorStatus = z.infer<typeof ActorStatus>

export const ActorOutcome = z.enum(["success", "failure", "cancelled"])
export type ActorOutcome = z.infer<typeof ActorOutcome>

export const Lifecycle = z.enum(["ephemeral", "persistent"])
export type Lifecycle = z.infer<typeof Lifecycle>

export const ContextMode = z.enum(["none", "state", "full"])
export type ContextMode = z.infer<typeof ContextMode>

export const SpawnMode = z.enum(["peer", "subagent", "main"])
export type SpawnMode = z.infer<typeof SpawnMode>

export const ToolWhitelist = z.union([z.array(z.string()).readonly(), z.literal("INHERIT")])
export type ToolWhitelist = z.infer<typeof ToolWhitelist>

export const Actor = z
  .object({
    sessionID: SessionID.zod,
    actorID: z.string(),
    mode: SpawnMode,
    parentActorID: z.string().optional(),
    status: ActorStatus,
    lastOutcome: ActorOutcome.optional(),
    lifecycle: Lifecycle,
    agent: z.string(),
    description: z.string(),
    contextMode: ContextMode,
    contextWatermark: MessageID.zod.optional(),
    background: z.boolean(),
    tools: ToolWhitelist.optional(),
    lastTurnTime: z.number(),
    turnCount: z.number(),
    // Last part write for this actor's slice. Optional because the column is
    // nullable — see actor.sql.ts. This is the liveness evidence; lastTurnTime
    // and turnCount are step bookkeeping and are NOT read by deriveLiveness.
    lastActivityTime: z.number().optional(),
    lastError: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      completed: z.number().optional(),
    }),
  })
  .meta({ ref: "Actor" })
export type Actor = z.infer<typeof Actor>

// Derived liveness: a pull-side signal computed from an actor row's honest
// registry fields (status, lastOutcome, lastActivityTime). It answers the
// question raw `status` cannot — is a running child PROGRESSING or STALLED?
//
// The evidence is LAST ACTIVITY, not last completed step. `last_activity_time`
// advances on every part write for the actor's slice (session/projectors.ts),
// so a child inside a long tool call, a slow model call or a retry/backoff keeps
// advancing it; only a child where nothing at all is landing goes quiet. The
// previous signal was `last_turn_time`, whose sole writer is the per-step
// heartbeat ActorRegistry.updateTurn — so the finest thing it could see was a
// COMPLETED step, and a child blocked mid-step was indistinguishable from a dead
// one. That coarseness is why the bound below used to be 30 minutes.
//   - progressing: running/pending AND activity within the staleness window.
//   - stalled: running/pending, but nothing has landed for longer than the
//     window. Still routable — it means "quiet", not "dead".
//   - success | failure | cancelled: terminal, taken straight from lastOutcome.
//   - idle: finished with no recorded outcome, an unknown state, OR a row whose
//     claim to be running/pending has outlived DEFAULT_LIVENESS_ABANDON_MS — see
//     that constant for why an unbounded claim is not honest.
// Never fabricates: every value maps 1:1 to fields the engine actually wrote.
export const Liveness = z.enum(["progressing", "stalled", "success", "failure", "cancelled", "idle"])
export type Liveness = z.infer<typeof Liveness>

// Default staleness threshold: a running child with no activity for this long is
// reported `stalled` (still routable — a display distinction, not a verdict).
// 90s was chosen against the per-step cadence; against the activity signal it is
// if anything more meaningful, because measured inter-activity gaps for real peer
// children are p50 994ms / p90 6.7s / p99 38s, so 90s of true silence is already
// past the 99th percentile.
export const DEFAULT_LIVENESS_STALL_MS = 90_000

// Abandonment bound: how long a row may keep CLAIMING `running`/`pending` before
// we stop believing it. `progressing` and `stalled` both read as "in progress" to
// every consumer (the orchestrator roster, `session list`, the fleet table) — they
// mark a child as routable and imply something is already in flight. That claim
// needs an upper bound, because the only repair for a row whose owner died is
// ActorRegistry's orphan sweep, and that sweep runs ONCE at process init and only
// for rows carrying a DIFFERENT instance_id; until it runs — and for any row it
// cannot reach — the row asserts progress with nothing behind it.
//
// 10 minutes. This replaces a 30-minute bound that existed only because the old
// signal was step-grained: a single legitimate step in this repo can run 20+
// minutes (a live test run ~1225s), so any bound had to clear that. Activity
// granularity removes that constraint, and the number is anchored to measurement
// rather than to the longest possible step:
//   - 2x STUCK_THRESHOLD_MS (registry.ts) — the repo's own existing "stuck" cutoff
//     — rather than a fresh magic number;
//   - ~16x the measured p99 inter-activity gap (38.0s) and ~2x p99.9 (296.8s) over
//     43,120 real gaps across a 172-child roster;
//   - ~345x the worst measured first-activity latency after spawn (1735ms, n=172,
//     p50 194ms), which is what licensed deleting the old turnCount === 0 case:
//     the "slow first turn queued behind the concurrency gate" it protected is
//     empirically under two seconds, not minutes, because the user message that
//     starts the turn is itself persisted as a part.
// Direction of error is unchanged and deliberate: prefer a duplicate child
// (wasteful) over routing into a corpse with re-dispatch suppressed
// (unrecoverable). Past the bound we report `idle` — "finished with no recorded
// outcome (or an unknown state)", the honest reading and the only non-routable
// bucket.
export const DEFAULT_LIVENESS_ABANDON_MS = 10 * 60_000

export function deriveLiveness(
  actor: Pick<Actor, "status" | "lastOutcome" | "lastActivityTime" | "time">,
  now: number = Date.now(),
  stallMs: number = DEFAULT_LIVENESS_STALL_MS,
  abandonMs: number = DEFAULT_LIVENESS_ABANDON_MS,
): Liveness {
  if (actor.status === "running" || actor.status === "pending") {
    // One reference for every row, no per-row special case: the last thing that
    // landed, or — when nothing has landed yet — the spawn time. `?? ` (not
    // `=== undefined`) because the column is nullable, so this value arrives as
    // `null` for pre-migration rows and a `!== undefined` guard would silently
    // pass them through. See AGENTS.md "Reading a nullable column".
    const since = actor.lastActivityTime ?? actor.time.created
    if (now - since > abandonMs) return "idle"
    return now - since <= stallMs ? "progressing" : "stalled"
  }
  if (actor.lastOutcome === "success") return "success"
  if (actor.lastOutcome === "failure") return "failure"
  if (actor.lastOutcome === "cancelled") return "cancelled"
  return "idle"
}
