export function usesGPTToolset(modelID: string) {
  return modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
}
