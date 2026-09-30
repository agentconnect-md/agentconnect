import { describe, expect, it } from 'vitest'
import {
  memoryProviderFor,
  MemoryProviderUnavailableError,
  type MemoryProviderKind
} from '../../src/memory/provider.js'
import { runtimeMemoryCapabilities } from '../../src/memory/runtime/capabilities.js'
import { PROFILES } from './profiles.js'

// Every curated harness declares its memory matrix, so adding one forces a review of its off-switch and native memory location.
describe.each(PROFILES)('runtime memory contract · $registryId', (profile) => {
  const agent = (provider: MemoryProviderKind) => ({
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
