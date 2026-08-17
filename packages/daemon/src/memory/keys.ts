/** Leaf module: pure memory key normalization, shared by the domain and transport layers. */
export function canonicalAgentMemoryKey(agentId: string): string {
  return `ac:agent:${agentId}`
}
