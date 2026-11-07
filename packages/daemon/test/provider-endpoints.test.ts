import { describe, expect, it } from 'vitest'
import { applyModelCredential, type ModelProviderTarget } from '../src/runtimes/model-provider-config.js'
import {
  hostCodexEndpoint,
  hostKeyEndpoint,
  PROVIDER_KEY_VARIABLES,
  runtimeKeyEndpoint
} from '../src/runtimes/provider-endpoints.js'

// One table decides where each runtime sends a provider key; the writers and every reader share it.

const gateway = (baseUrl: string) =>
  JSON.stringify({ methodId: 'gateway', _meta: { gateway: { baseUrl, headers: {} } } })
const openCodeConfig = (name: string, provider: Record<string, unknown>) => ({ [name]: JSON.stringify({ provider }) })

type Row = [string, ModelProviderTarget['runtime'], string, Record<string, string>, string | undefined]

describe('the endpoint a launch sends a provider key to', () => {
  const rows: Row[] = [
    ['claude default', 'claude', 'ANTHROPIC_API_KEY', {}, 'https://api.anthropic.com'],
    [
      'claude base',
      'claude',
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_BASE_URL: 'https://a.example.test' },
      'https://a.example.test'
    ],
    ['claude blank base', 'claude', 'ANTHROPIC_API_KEY', { ANTHROPIC_BASE_URL: ' ' }, 'https://api.anthropic.com'],
    [
      'claude http base',
      'claude',
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_BASE_URL: 'http://a.example.test' },
      'http://a.example.test'
    ],
    ['claude other key', 'claude', 'OPENAI_API_KEY', {}, undefined],
    ['codex default', 'codex', 'OPENAI_API_KEY', {}, 'https://api.openai.com/v1'],
    [
      'codex OPENAI_BASE_URL',
      'codex',
      'OPENAI_API_KEY',
      { OPENAI_BASE_URL: 'https://o.example.test/v1' },
      'https://o.example.test/v1'
    ],
    [
      'codex configured base first',
      'codex',
      'OPENAI_API_KEY',
      {
        CODEX_CONFIG: JSON.stringify({ openai_base_url: 'https://c.example.test/v1' }),
        OPENAI_BASE_URL: 'https://o.example.test/v1'
      },
      'https://c.example.test/v1'
    ],
    [
      'codex gateway request',
      'codex',
      'OPENAI_API_KEY',
      { DEFAULT_AUTH_REQUEST: gateway('https://g.example.test/v1') },
      'https://g.example.test/v1'
    ],
    [
      'codex gateway disagreeing with base',
      'codex',
      'OPENAI_API_KEY',
      { DEFAULT_AUTH_REQUEST: gateway('https://g.example.test/v1'), OPENAI_BASE_URL: 'https://o.example.test/v1' },
      undefined
    ],
    [
      'codex non-gateway request',
      'codex',
      'OPENAI_API_KEY',
      { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'chat-gpt' }) },
      undefined
    ],
    [
      'codex custom provider',
      'codex',
      'OPENAI_API_KEY',
      { CODEX_CONFIG: JSON.stringify({ model_provider: 'example' }) },
      undefined
    ],
    ['codex unreadable config', 'codex', 'OPENAI_API_KEY', { CODEX_CONFIG: 'not json' }, undefined],
    ['deepseek default', 'deepseek', 'DEEPSEEK_API_KEY', {}, 'https://api.deepseek.com'],
    [
      'deepseek base',
      'deepseek',
      'DEEPSEEK_API_KEY',
      { DEEPSEEK_BASE_URL: 'https://d.example.test' },
      'https://d.example.test'
    ],
    ['deepseek other key', 'deepseek', 'ANTHROPIC_API_KEY', {}, undefined],
    [
      'qwen anthropic',
      'qwen',
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_BASE_URL: 'https://a.example.test' },
      'https://a.example.test'
    ],
    ['qwen openai default', 'qwen', 'OPENAI_API_KEY', {}, 'https://api.openai.com/v1'],
    ['qwen deepseek key', 'qwen', 'DEEPSEEK_API_KEY', {}, undefined],
    [
      'goose anthropic host',
      'goose',
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_HOST: 'https://a.example.test' },
      'https://a.example.test'
    ],
    [
      'goose ignores ANTHROPIC_BASE_URL',
      'goose',
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_BASE_URL: 'https://x.example.test' },
      'https://api.anthropic.com'
    ],
    [
      'goose openai base',
      'goose',
      'OPENAI_API_KEY',
      { OPENAI_BASE_URL: 'https://o.example.test/v1' },
      'https://o.example.test/v1'
    ],
    ['goose OPENAI_HOST', 'goose', 'OPENAI_API_KEY', { OPENAI_HOST: 'https://h.example.test' }, undefined],
    [
      'copilot named provider',
      'copilot',
      'COPILOT_PROVIDER_API_KEY',
      { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: 'https://p.example.test/v1' },
      'https://p.example.test/v1'
    ],
    ['copilot without base', 'copilot', 'COPILOT_PROVIDER_API_KEY', { COPILOT_PROVIDER_TYPE: 'openai' }, undefined],
    [
      'copilot unknown type',
      'copilot',
      'COPILOT_PROVIDER_API_KEY',
      { COPILOT_PROVIDER_TYPE: 'azure', COPILOT_PROVIDER_BASE_URL: 'https://p.example.test' },
      undefined
    ],
    ['copilot other key', 'copilot', 'OPENAI_API_KEY', { COPILOT_PROVIDER_TYPE: 'openai' }, undefined],
    ['opencode default', 'opencode', 'DEEPSEEK_API_KEY', {}, 'https://api.deepseek.com'],
    [
      'opencode configured base',
      'opencode',
      'ANTHROPIC_API_KEY',
      openCodeConfig('OPENCODE_CONFIG_CONTENT', { anthropic: { options: { baseURL: 'https://a.example.test/v1' } } }),
      'https://a.example.test/v1'
    ],
    [
      'opencode variable shared with another provider',
      'opencode',
      'OPENAI_API_KEY',
      openCodeConfig('OPENCODE_CONFIG_CONTENT', { example: { options: { apiKey: '{env:OPENAI_API_KEY}' } } }),
      undefined
    ],
    ['opencode unreadable config', 'opencode', 'OPENAI_API_KEY', { OPENCODE_CONFIG_CONTENT: 'not json' }, undefined],
    ['opencode unknown key', 'opencode', 'COPILOT_PROVIDER_API_KEY', {}, undefined],
    [
      'kilo reads its own document',
      'kilo',
      'OPENAI_API_KEY',
      {
        ...openCodeConfig('KILO_CONFIG_CONTENT', { openai: { options: { baseURL: 'https://k.example.test/v1' } } }),
        ...openCodeConfig('OPENCODE_CONFIG_CONTENT', { openai: { options: { baseURL: 'https://x.example.test/v1' } } })
      },
      'https://k.example.test/v1'
    ]
  ]

  it.each(rows)('%s', (_label, runtime, name, env, endpoint) => {
    expect(runtimeKeyEndpoint({ runtime }, name, env)?.endpoint).toBe(endpoint)
  })

  it('names no endpoint without a runtime, and lists every key variable a runtime reads', () => {
    expect(runtimeKeyEndpoint(undefined, 'OPENAI_API_KEY', {})).toBeUndefined()
    expect(PROVIDER_KEY_VARIABLES).toEqual([
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'COPILOT_PROVIDER_API_KEY'
    ])
  })
})

describe('what the writers put in a launch, read back', () => {
  const targets: ModelProviderTarget[] = [
    { provider: 'anthropic', runtime: 'claude' },
    { provider: 'openai', runtime: 'codex' },
    { provider: 'deepseek', runtime: 'deepseek' },
    { provider: 'anthropic', runtime: 'qwen' },
    { provider: 'openai', runtime: 'qwen' },
    { provider: 'anthropic', runtime: 'goose' },
    { provider: 'openai', runtime: 'goose' },
    { provider: 'anthropic', runtime: 'copilot' },
    { provider: 'openai', runtime: 'copilot' },
    { provider: 'anthropic', runtime: 'opencode', opencodeProvider: 'anthropic' },
    { provider: 'openai', runtime: 'opencode', opencodeProvider: 'openai' },
    { provider: 'anthropic', runtime: 'kilo', opencodeProvider: 'anthropic' },
    { provider: 'openai', runtime: 'kilo', opencodeProvider: 'openai' }
  ]

  it.each(targets)('$runtime sends a written $provider key to the written base', (target) => {
    const env: Record<string, string> = {}
    applyModelCredential(target, env, { key: 'example-key', baseUrl: 'https://models.example.test/v1' })
    const [name] = Object.entries(env).find(([, value]) => value === 'example-key')!
    expect(runtimeKeyEndpoint(target, name, env)).toEqual({
      provider: target.provider,
      endpoint: 'https://models.example.test/v1'
    })
  })
})

describe('the endpoint a host launch sends its own key to', () => {
  it('takes a set base variable as it stands, so a blank one names none', () => {
    expect(hostKeyEndpoint('claude', 'ANTHROPIC_API_KEY', {})?.endpoint).toBe('https://api.anthropic.com')
    expect(
      hostKeyEndpoint('claude', 'ANTHROPIC_API_KEY', { ANTHROPIC_BASE_URL: 'https://a.example.test' })?.endpoint
    ).toBe('https://a.example.test')
    expect(hostKeyEndpoint('claude', 'ANTHROPIC_API_KEY', { ANTHROPIC_BASE_URL: '' })).toBeUndefined()
    expect(hostKeyEndpoint('deepseek', 'DEEPSEEK_API_KEY', {})?.endpoint).toBe('https://api.deepseek.com')
    expect(hostKeyEndpoint('claude', 'OPENAI_API_KEY', {})).toBeUndefined()
  })

  it("follows a host Codex's merged configuration, and none beside OPENAI_BASE_URL", () => {
    const config = { openai_base_url: 'https://c.example.test/v1' }
    expect(hostKeyEndpoint('codex', 'OPENAI_API_KEY', {}, () => config)?.endpoint).toBe('https://c.example.test/v1')
    expect(hostKeyEndpoint('codex', 'OPENAI_API_KEY', {})?.endpoint).toBe('https://api.openai.com/v1')
    expect(
      hostKeyEndpoint('codex', 'OPENAI_API_KEY', { OPENAI_BASE_URL: 'https://o.example.test/v1' }, () => config)
    ).toBeUndefined()
    const custom = (requires: boolean) => ({
      model_provider: 'example',
      model_providers: { example: { base_url: 'https://e.example.test/v1', requires_openai_auth: requires } }
    })
    expect(hostCodexEndpoint(custom(true))?.endpoint).toBe('https://e.example.test/v1')
    expect(hostCodexEndpoint(custom(false))).toBeUndefined()
    expect(() => hostCodexEndpoint({ model_providers: 'not a table' })).toThrow()
  })
})
