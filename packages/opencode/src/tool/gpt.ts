export function isGPTModel(...values: Array<string | undefined>) {
  return values.some((value) => {
    const id = value?.toLowerCase()
    return id?.includes("gpt") && !id.includes("gpt-oss")
  })
}

export function usesGPTToolset(modelID: string) {
  return modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
}
