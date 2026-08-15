import type { LaunchGenerations } from '../src/k8s/driver.js'

/** Process-local stand-in for the shared store, for tests that only need generations to increase. */
export function fakeGenerations(): LaunchGenerations {
  const counters = new Map<string, number>()
  return {
    nextSandboxGeneration(agentId: string): number {
      const next = (counters.get(agentId) ?? 0) + 1
      counters.set(agentId, next)
      return next
    }
  }
}
