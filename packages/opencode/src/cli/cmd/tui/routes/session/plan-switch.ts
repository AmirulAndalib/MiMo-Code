import type { ToolPart } from "@mimo-ai/sdk/v2"

export function planSwitchTarget(part: Pick<ToolPart, "tool" | "state">): "build" | "plan" | undefined {
  if (part.state.status !== "completed") return undefined
  if (part.state.metadata.switched !== true) return undefined
  if (part.tool === "plan_exit") return "build"
  if (part.tool === "plan_enter") return "plan"
  return undefined
}
