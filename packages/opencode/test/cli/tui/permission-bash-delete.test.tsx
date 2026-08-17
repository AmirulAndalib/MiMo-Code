/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { BashDeleteBody } from "../../../src/cli/cmd/tui/routes/session/permission"

const WARNING = RGBA.fromHex("#e0af68")

const theme = {
  text: RGBA.fromHex("#eeeeee"),
  textMuted: RGBA.fromHex("#808080"),
  warning: WARNING,
  background: RGBA.fromHex("#0a0a0a"),
  borderActive: RGBA.fromHex("#484848"),
  selectedListItemText: RGBA.fromHex("#141414"),
  _hasSelectedListItemText: true,
} as never

const command = [
  "cd packages/opencode",
  "bun install --frozen-lockfile",
  "bun run build:local --target darwin-arm64",
  "rm -rf dist/tmp",
  "rm -rf node_modules/.cache",
  "bun test src/tool --coverage",
  "echo done",
].join(" && ")

const deletes = Array.from({ length: 6 }, (_, i) => `rm -rf packages/opencode/artifact-dir-${i}`)

// Mirrors the Prompt shell in permission.tsx: hard maxHeight, header and
// footer pinned with flexShrink=0, body squeezed in between.
function Shell(props: { maxHeight: number }) {
  return (
    <box maxHeight={props.maxHeight}>
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <box paddingLeft={1} flexShrink={0}>
          <text fg={(theme as any).text}>Permission required</text>
          <text fg={(theme as any).text}>Confirm irreversible deletion</text>
        </box>
        <BashDeleteBody command={command} deletes={deletes} theme={theme} />
      </box>
      <box flexShrink={0} paddingTop={1} paddingBottom={1} paddingLeft={2}>
        <text fg={(theme as any).text}>Allow once</text>
      </box>
    </box>
  )
}

function sameColor(a: RGBA | undefined, b: RGBA) {
  if (!a) return false
  const buf = (c: RGBA) => [0, 1, 2].map((i) => Math.round(c.buffer[i] * 255))
  return buf(a).join(",") === buf(b).join(",")
}

test("bash_delete prompt keeps every deletion line visible when squeezed", async () => {
  const app = await testRender(() => <Shell maxHeight={15} />, { width: 100, height: 20 })
  await app.renderOnce()
  await app.renderOnce()

  const frame = app.captureCharFrame()
  for (const cmd of deletes) {
    expect(frame).toContain("- " + cmd)
  }
  expect(frame).toContain("Detected deletions")
  expect(frame).toContain("Allow once")
})

test("bash_delete deletion lines paint every cell with the warning background", async () => {
  const app = await testRender(() => <Shell maxHeight={15} />, { width: 100, height: 20 })
  await app.renderOnce()
  await app.renderOnce()

  const captured = app.captureSpans()
  const rows = captured.lines.filter((line) => line.spans.some((s) => s.text.includes("- rm -rf")))
  expect(rows.length).toBe(deletes.length)

  for (const row of rows) {
    const span = row.spans.find((s) => s.text.includes("- rm -rf"))!
    // one contiguous run: spaces inside the line share the same painted cells
    expect(span.text.startsWith(" - rm -rf ")).toBe(true)
    expect(span.text.endsWith(" ")).toBe(true)
    expect(sameColor(span.bg, WARNING)).toBe(true)
  }
})
