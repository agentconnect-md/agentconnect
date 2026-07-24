import { describe, it, expect } from 'vitest'
import { agentChildEnv } from '../src/agents/agent-env.js'

describe('agentChildEnv', () => {
  it('returns UI-configured env and secrets', () => {
    expect(
      agentChildEnv({
        runtimeOverrides: { env: [{ name: 'A', value: '1' }], secrets: [{ name: 'API_KEY', value: 'sk-xyz' }] }
      })
    ).toEqual({ A: '1', API_KEY: 'sk-xyz' })
  })

  it('lets a secret win over an ordinary env var of the same name', () => {
    const merged = agentChildEnv({
      runtimeOverrides: {
        env: [{ name: 'TOKEN', value: 'from-env-override' }],
        secrets: [{ name: 'TOKEN', value: 'from-secret' }]
      }
    })
    expect(merged).toEqual({ TOKEN: 'from-secret' })
  })
})
