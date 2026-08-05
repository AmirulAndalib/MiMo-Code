import { describe, expect, test } from "bun:test"
import { resolveVisualMode, visualMotionEnabled } from "@/cli/cmd/tui/context/visual"

describe("TUI visual mode", () => {
  test("defaults missing and invalid state to minimal", () => {
    expect(resolveVisualMode(undefined)).toBe("minimal")
    expect(resolveVisualMode("unknown")).toBe("minimal")
  })

  test("preserves the vivid preference", () => {
    expect(resolveVisualMode("vivid")).toBe("vivid")
  })

  test("only enables cosmetic motion for vivid visuals with animations enabled", () => {
    expect(visualMotionEnabled("minimal", true)).toBe(false)
    expect(visualMotionEnabled("minimal", false)).toBe(false)
    expect(visualMotionEnabled("vivid", false)).toBe(false)
    expect(visualMotionEnabled("vivid", true)).toBe(true)
  })
})
