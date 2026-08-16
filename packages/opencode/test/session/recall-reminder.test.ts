import { describe, test, expect } from "bun:test"
import { recallHintLines } from "../../src/session/prompt"
import { hasActorTool } from "../../src/agent/config"

describe("recallHintLines", () => {
  test("json mode (no tool config): task and actor use JSON form", () => {
    const lines = recallHintLines(undefined)
    expect(lines).toContain(`- task({ operation: "list" })`)
    expect(lines).toContain(`- actor({ operation: "status", actor_id: "<id>" })`)
    expect(lines.some((l) => l.includes(`memory({ operation: "search"`))).toBe(true)
  })

  test("shell mode for task+actor: shell forms, no JSON for those tools", () => {
    const lines = recallHintLines({ invocation_style: "shell" })
    expect(lines).toContain("- task list")
    expect(lines).toContain("- actor status <actor_id>")
    expect(lines.some((l) => l.includes(`task({ operation`))).toBe(false)
    expect(lines.some((l) => l.includes(`actor({ operation`))).toBe(false)
    expect(lines.some((l) => l.includes(`memory({ operation: "search"`))).toBe(true)
  })

  test("per-tool: task shell, actor json", () => {
    const lines = recallHintLines({ invocation_style_by_tool: { task: "shell" } })
    expect(lines).toContain("- task list")
    expect(lines).toContain(`- actor({ operation: "status", actor_id: "<id>" })`)
  })

  // Guards the positional contract the reminder block relies on: hints[0]=memory,
  // hints[1]=task, hints[2]=actor. A future edit that reorders the returned array
  // would silently swap which hint lands in which reminder slot — this catches it.
  test("returned order is [memory, task, actor]", () => {
    const lines = recallHintLines({ invocation_style: "shell" })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("memory(")
    expect(lines[1]).toBe("- task list")
    expect(lines[2]).toBe("- actor status <actor_id>")
  })

  test("drops the actor hint when the tool is masked out for the agent", () => {
    const lines = recallHintLines({ invocation_style: "shell" }, false)
    expect(lines).toEqual([`- memory({ operation: "search", query: "<keyword>" })`, "- task list"])
  })
})

// The reminder names `actor`, so it must read the same gate ToolRegistry.available
// uses to mask the tool out — otherwise a subagent is told to call a tool it has
// no schema for.
describe("hasActorTool", () => {
  test("primaries and system-spawned agents keep it, other subagents don't", () => {
    expect(hasActorTool({ name: "build", mode: "primary" })).toBe(true)
    expect(hasActorTool({ name: "helper", mode: "all" })).toBe(true)
    expect(hasActorTool({ name: "checkpoint-writer", mode: "subagent" })).toBe(true)
    expect(hasActorTool({ name: "general", mode: "subagent" })).toBe(false)
    expect(hasActorTool({ name: "explore", mode: "subagent" })).toBe(false)
  })
})
