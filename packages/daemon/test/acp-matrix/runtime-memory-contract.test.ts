import { describe, expect, it } from 'vitest'
import { ASSISTANT_MODE_RUNTIME_FACTS } from '@agentconnect.md/protocol'
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

// Admission's "native memory can be disabled" (assistant-mode.md §4.1) must name a runtime whose off-switch is verified here.
describe.each(
  Object.entries(ASSISTANT_MODE_RUNTIME_FACTS)
    .filter(([, facts]) => facts.nativeMemoryDisableable)
    .map(([id]) => ({ id }))
)('assistant mode admission · $id', ({ id }) => {
  it('launches with the verified off-switch applied', () => {
    // The earlier generation's ids ("claude", "codex") are the same adapters as their `-acp` profiles.
    const profile = PROFILES.find((p) => p.registryId === id || p.registryId === `${id}-acp`)
    expect(profile, `no runtime profile for admitted runtime ${id}`).toBeDefined()
    const capabilities = runtimeMemoryCapabilities(profile!.memory.runtime, id)
    expect(capabilities.none).toBe(true)
    const env = memoryProviderFor(
      { runtime: id, assistantMode: { enabled: true } },
      profile!.memory.runtime
    ).runtimeEnv()
    // A runtime that keeps a memory of its own gets a non-empty off-switch; one with none needs nothing.
    if (capabilities.native) expect(env).not.toEqual({})
  })
})
