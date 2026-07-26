import { describe, expect, test } from "bun:test"
import { isGPTModel } from "../../src/tool/gpt"

describe("isGPTModel", () => {
  test("recognizes every GPT version and aliases resolved through API metadata", () => {
    expect(isGPTModel("gpt-4o")).toBe(true)
    expect(isGPTModel("chatgpt-4o-latest")).toBe(true)
    expect(isGPTModel("gpt-5.3-codex")).toBe(true)
    expect(isGPTModel("gateway/openai/gpt-5.6")).toBe(true)
    expect(isGPTModel("company-alias", "gpt-5.4", "gpt-5")).toBe(true)
  })

  test("does not classify Claude or GPT-OSS as GPT provider models", () => {
    expect(isGPTModel("claude-opus-4-6")).toBe(false)
    expect(isGPTModel("gpt-oss-120b")).toBe(false)
  })
})
