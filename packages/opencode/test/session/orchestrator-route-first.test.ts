import { describe, expect, test } from "bun:test"
import PROMPT_ORCHESTRATOR from "../../src/session/prompt/orchestrator.txt"

// ============================================================
// Orchestrator route-first + digital-twin behavior tests — PR #1741
//
// These test the PROMPT CONTENT (what guidance the orchestrator.txt encodes).
// Roster injection/filtering is tested via the existing llm-system-prompt.test.ts
// which exercises the full buildSystemArray path. These tests verify the
// behavioral guidance is present and correct — the mechanism that determines
// the orchestrator's behavior given the roster.
//
// For behaviors only testable via e2e (actual create-vs-route decision, the
// AI's judgment given the roster + prompt), the mechanism tests (roster
// correctly injected + filtered, prompt correctly guides) ARE the regression
// protection. The actual LLM decision is inherently non-deterministic and
// covered by manual TUI verification.
// ============================================================

describe("orchestrator prompt — digital-twin identity", () => {
  test("declares itself as user's digital twin", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/DIGITAL TWIN/i)
  })

  test("ACT, DON'T ASK principle present", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/ACT, DON.*T ASK/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/Default = do it, then report/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/Do not ask.*shall I do/)
  })

  test("PROACTIVELY COMPLETE THE INTENT principle present", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/PROACTIVELY COMPLETE THE INTENT/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/FULL intent/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/proactively/)
  })

  test("REPORT-not-ask phrasing guidance present", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/REPORT.*don.*t ask/)
    // Has good/bad examples
    expect(PROMPT_ORCHESTRATOR).toMatch(/BAD:.*Shall I/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/GOOD:.*proactively/)
  })

  test("route-analysis, don't self-analyze principle present", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Route analysis.*don.*t self-analyze/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/DISPATCH a session to analyze/)
  })
})

describe("orchestrator prompt — four core duties", () => {
  test("declares four core duties", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/four core duties/)
  })

  test("duty 1: Dispatch — route work", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Dispatch.*route work/i)
    expect(PROMPT_ORCHESTRATOR).toContain("<active-sessions>")
    expect(PROMPT_ORCHESTRATOR).toContain("session send")
    expect(PROMPT_ORCHESTRATOR).toContain("session create")
  })

  test("duty 2: Act for user — answer, approve, decide", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Act for the user.*answer.*approve.*decide/i)
    expect(PROMPT_ORCHESTRATOR).toContain("session approve")
    expect(PROMPT_ORCHESTRATOR).toContain("grant-approval")
  })

  test("duty 3: Proactively complete the intent", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Proactively complete the intent/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/FULL intent/)
  })

  test("duty 4: Audit quality — verify before declaring done", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Audit quality.*verify before declaring done/)
    expect(PROMPT_ORCHESTRATOR).toContain("session status")
    expect(PROMPT_ORCHESTRATOR).toContain("session ask")
  })
})

describe("orchestrator prompt — route-first dispatch", () => {
  test("instructs to route to existing session before creating", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/DO NOT create.*existing/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/existing one can handle/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/existing child first.*create only as fallback/i)
  })

  test("mentions session send as primary dispatch verb", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/primary dispatch verb/)
  })

  test("references active-sessions block for routing decisions", () => {
    expect(PROMPT_ORCHESTRATOR).toContain("<active-sessions>")
    expect(PROMPT_ORCHESTRATOR).toMatch(/compact format.*id.*title.*mode.*status/i)
  })
})

describe("orchestrator prompt — session lifecycle safety", () => {
  test("finished sessions stay resumable, cancel is destroy-only", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Finished sessions stay resumable/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/DESTROY/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/Completed.*never means.*cancel/i)
  })

  test("don't poll, wait event-driven", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/don.*t poll/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/event-driven/)
  })

  test("idle without notification — verify with git", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Idle without notification/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/verify with git/)
  })
})

describe("orchestrator prompt — safety invariants", () => {
  test("never blocks on real work", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/MUST NEVER block/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/actor run.*actor spawn/i)
  })

  test("captures requirements before acting", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Capture requirements before acting/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/reflex/)
  })

  test("delegates slow analysis", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Delegate slow ANALYSIS/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/never run it inline/)
  })
})
