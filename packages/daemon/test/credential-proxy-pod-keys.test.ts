import { describe, expect, it } from 'vitest'
import { carries, launchOverlay, pairEndpoint, runtimeKeyEndpoint } from '../src/credential-proxy/pod-keys.js'

// Where a pool pod's runtime sends an install key, read from its launch env as the runtime reads it.

describe('the endpoint a pod launch sends an install key to', () => {
  it("sends a pair's key to its base URL, else to its provider's own endpoint", () => {
    expect(pairEndpoint('anthropic', undefined)).toEqual({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com'
    })
    expect(pairEndpoint('openai', 'https://gateway.example.test/v1')).toEqual({
      provider: 'openai',
      endpoint: 'https://gateway.example.test/v1'
    })
    expect(pairEndpoint('deepseek', undefined)?.endpoint).toBe('https://api.deepseek.com')
    expect(pairEndpoint('typesafe', undefined)).toBeUndefined()
  })

  it("reads each runtime's own endpoint variable for the key it sends", () => {
    const claude = { provider: 'anthropic', runtime: 'claude' } as const
    expect(runtimeKeyEndpoint(claude, 'ANTHROPIC_API_KEY', {})?.endpoint).toBe('https://api.anthropic.com')
    expect(
      runtimeKeyEndpoint(claude, 'ANTHROPIC_API_KEY', { ANTHROPIC_BASE_URL: 'https://models.example.test' })?.endpoint
    ).toBe('https://models.example.test')
    // A variable the runtime does not send to a provider is not a key it holds for one.
    expect(runtimeKeyEndpoint(claude, 'OPENAI_API_KEY', {})).toBeUndefined()
    const qwen = { provider: 'openai', runtime: 'qwen' } as const
    expect(runtimeKeyEndpoint(qwen, 'OPENAI_API_KEY', { OPENAI_BASE_URL: 'https://models.example.test/v1' })).toEqual({
      provider: 'openai',
      endpoint: 'https://models.example.test/v1'
    })
    const copilot = { provider: 'openai', runtime: 'copilot' } as const
    expect(runtimeKeyEndpoint(copilot, 'COPILOT_PROVIDER_API_KEY', { COPILOT_PROVIDER_TYPE: 'openai' })).toBeUndefined()
    expect(
      runtimeKeyEndpoint(copilot, 'COPILOT_PROVIDER_API_KEY', {
        COPILOT_PROVIDER_TYPE: 'anthropic',
        COPILOT_PROVIDER_BASE_URL: 'https://models.example.test'
      })
    ).toEqual({ provider: 'anthropic', endpoint: 'https://models.example.test' })
    expect(runtimeKeyEndpoint(undefined, 'OPENAI_API_KEY', {})).toBeUndefined()
  })

  it("follows Codex's configured base before OPENAI_BASE_URL, as the pod shim does", () => {
    const codex = { provider: 'openai', runtime: 'codex' } as const
    expect(runtimeKeyEndpoint(codex, 'OPENAI_API_KEY', {})?.endpoint).toBe('https://api.openai.com/v1')
    const env = {
      CODEX_CONFIG: JSON.stringify({ openai_base_url: 'https://gateway.example.test/v1' }),
      OPENAI_BASE_URL: 'https://other.example.test/v1'
    }
    expect(runtimeKeyEndpoint(codex, 'OPENAI_API_KEY', env)?.endpoint).toBe('https://gateway.example.test/v1')
    const otherProvider = { CODEX_CONFIG: JSON.stringify({ model_provider: 'example' }) }
    expect(runtimeKeyEndpoint(codex, 'OPENAI_API_KEY', otherProvider)).toBeUndefined()
  })

  it("reads an OpenCode config's base URL, and names none when another provider reads the same variable", () => {
    const opencode = { provider: 'anthropic', runtime: 'opencode', opencodeProvider: 'anthropic' } as const
    const config = (provider: Record<string, unknown>) => ({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider }) })
    expect(runtimeKeyEndpoint(opencode, 'DEEPSEEK_API_KEY', {})?.endpoint).toBe('https://api.deepseek.com')
    expect(
      runtimeKeyEndpoint(
        opencode,
        'ANTHROPIC_API_KEY',
        config({ anthropic: { options: { baseURL: 'https://models.example.test/v1' } } })
      )?.endpoint
    ).toBe('https://models.example.test/v1')
    const shared = config({
      example: { options: { apiKey: '{env:OPENAI_API_KEY}', baseURL: 'https://x.example.test' } }
    })
    expect(runtimeKeyEndpoint(opencode, 'OPENAI_API_KEY', shared)).toBeUndefined()
    expect(runtimeKeyEndpoint(opencode, 'OPENAI_API_KEY', { OPENCODE_CONFIG_CONTENT: 'not json' })).toBeUndefined()
  })
})

describe('the launch overlay', () => {
  it('holds the variables that changed, and finds a value embedded anywhere in a launch', () => {
    expect(launchOverlay({ A: '1', B: '2' }, { A: '1', B: 'p', C: 'q' })).toEqual({ B: 'p', C: 'q' })
    expect(carries({ DOC: '{"apiKey":"example-secret"}' }, 'example-secret')).toBe(true)
    expect(carries({ A: 'other' }, 'example-secret')).toBe(false)
  })
})
