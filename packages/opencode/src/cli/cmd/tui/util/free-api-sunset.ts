import { createSignal, onCleanup } from "solid-js"

export const FREE_API_SUNSET_AT = Date.parse("2026-07-26T10:00:00.000Z")

export function isFreeApiSunset(now = Date.now()) {
  return now >= FREE_API_SUNSET_AT
}

export function isFreeApiModel(model: { providerID: string; modelID: string } | undefined) {
  return model?.providerID === "mimo" && model.modelID === "mimo-auto"
}

export type PromptSubmission = "client-slash" | "shell" | "model"

export function classifyPromptSubmission(input: {
  input: string
  mode: "normal" | "shell"
  clientSlash: boolean
}): PromptSubmission {
  if (input.mode === "shell") return "shell"
  if (input.input.trim() === "/btw") return "model"
  if (input.input.startsWith("/") && input.clientSlash) return "client-slash"
  return "model"
}

export function isModelBackedPromptSubmission(request: PromptSubmission) {
  return request === "model"
}

export function shouldBlockFreeApiRequest(
  model: { providerID: string; modelID: string } | undefined,
  options: {
    now?: number
    sunset?: boolean
    request?: PromptSubmission
    clientSlash?: boolean
    shell?: boolean
  } = {},
) {
  if (!(options.sunset ?? isFreeApiSunset(options.now))) return false
  if (!isFreeApiModel(model)) return false
  if (options.request) return isModelBackedPromptSubmission(options.request)
  return !options.clientSlash && !options.shell
}

export function freeApiModelNameKey(sunset = isFreeApiSunset()) {
  return sunset ? ("tui.model.mimo_auto.sunset_name" as const) : ("tui.model.mimo_auto.name" as const)
}

export function createFreeApiSunsetSignal(
  now = Date.now(),
  timer: {
    set(callback: () => void, delay: number): ReturnType<typeof setTimeout>
    clear(handle: ReturnType<typeof setTimeout>): void
  } = {
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (handle) => clearTimeout(handle),
  },
) {
  const [sunset, setSunset] = createSignal(isFreeApiSunset(now))
  if (sunset()) return sunset
  const timeout = timer.set(() => setSunset(true), FREE_API_SUNSET_AT - now)
  onCleanup(() => timer.clear(timeout))
  return sunset
}
