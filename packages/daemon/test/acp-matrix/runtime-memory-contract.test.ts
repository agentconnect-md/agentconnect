import { describe, expect, it } from 'vitest'
import {
  memoryProviderFor,
  MemoryProviderUnavailableError,
  type MemoryProviderKind
} from '../../src/memory/provider.js'
import { runtimeMemoryCapabilities } from '../../src/memory/runtime/capabilities.js'
import { PROFILES } from './profiles.js'

/**
 * Harness-addition gate for the runtime-specific part of memory providers.
 *
 * `profiles.ts` is the curated set of ACP harnesses AgentConnect claims to cover.
 * Making every profile declare an expected provider matrix turns memory handling
 * into part of that support contract: adding a harness requires an explicit review
 * of its native-memory off-switch and redirect semantics, rather than discovering
 * the omission when a user first selects `none`.
 */
describe.each(PROFILES)('runtime memory contract · $registryId', (profile) => {
  const agent = (provider: MemoryProviderKind) => ({
    dir: '/agents/bot-a',
    runtime: profile.registryId,
    memory: { provider }
  })

  it('matches the profile-declared provider capabilities', () => {
    expect(runtimeMemoryCapabilities(profile.memory.runtime, profile.registryId)).toEqual(profile.memory.expected)
  })

  it('keeps managed available and gates none/native on verified policies', () => {
    expect(() => memoryProviderFor(agent('managed'), profile.memory.runtime).runtimeEnv()).not.toThrow()

    for (const provider of ['none', 'native'] as const) {
      const run = () => memoryProviderFor(agent(provider), profile.memory.runtime).runtimeEnv()
      if (profile.memory.expected[provider]) expect(run).not.toThrow()
      else expect(run).toThrow(MemoryProviderUnavailableError)
    }
  })
})
