import { describe, expect, test } from "bun:test"
import { isGPTModel, isMcpToolSearchEnabled, isMimoModel, usesGPTToolset } from "../../src/tool/gpt"

describe("isGPTModel", () => {
  test("recognizes GPT versions and API aliases", () => {
    expect(isGPTModel("gpt-4o")).toBe(true)
    expect(isGPTModel("chatgpt-4o-latest")).toBe(true)
    expect(isGPTModel("gpt-5.3-codex")).toBe(true)
    expect(isGPTModel("company-alias", "gpt-5.4", "gpt-5")).toBe(true)
  })

  test("excludes non-GPT and GPT-OSS models", () => {
    expect(isGPTModel("claude-opus-4-6")).toBe(false)
    expect(isGPTModel("gpt-oss-120b")).toBe(false)
    expect(isGPTModel("company-gpt-production", "gpt-oss-120b", "gpt-oss")).toBe(false)
  })
})

describe("isMcpToolSearchEnabled", () => {
  test("defaults to GPT models and allows explicit non-GPT opt-in", () => {
    expect(isMcpToolSearchEnabled(false, "claude-opus-4-6")).toBe(false)
    expect(isMcpToolSearchEnabled(false, "gpt-5.2")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "mimo-v2.6")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "mimo-v2.5")).toBe(true)
    expect(isMcpToolSearchEnabled(false, "gpt-oss-120b")).toBe(false)
    expect(isMcpToolSearchEnabled(true, "claude-opus-4-6")).toBe(true)
  })
})

describe("isMimoModel", () => {
  test("recognizes MiMo models across model ID formats", () => {
    expect(isMimoModel("mimo-v2")).toBe(true)
    expect(isMimoModel("mimo-v2.5-pro")).toBe(true)
    expect(isMimoModel("mimo-v2.6")).toBe(true)
    expect(isMimoModel("XiaomiMiMo/MiMo-V2.6-Pro")).toBe(true)
    expect(isMimoModel("mimo-auto")).toBe(true)
  })

  test("excludes unrelated models", () => {
    expect(isMimoModel("minimax-m2.5")).toBe(false)
    expect(isMimoModel("gpt-5.4")).toBe(false)
  })

  test("enables the GPT toolset for every MiMo model", () => {
    expect(usesGPTToolset("mimo-v2")).toBe(true)
    expect(usesGPTToolset("mimo-v2.5-pro")).toBe(true)
    expect(usesGPTToolset("mimo-auto")).toBe(true)
  })
})
