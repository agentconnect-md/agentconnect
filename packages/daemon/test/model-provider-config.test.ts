import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/agents/agent-schema.js'
import type { RuntimeDef } from '../src/config/config-schema.js'
import {
  applyModelCredential,
  applyStaticModelConfig,
  configuredModelCredentials,
  modelProviderTarget
} from '../src/runtimes/model-provider-config.js'

const runtime = (command: string, args: string[] = []): RuntimeDef => ({ command, args, env: [] })
const agent = (runtimeId: string, model?: string): Pick<Agent, 'runtime' | 'runtimeOverrides'> => ({
  runtime: runtimeId,
  ...(model ? { runtimeOverrides: { model, env: [], secrets: [] } } : {})
})

describe('modelProviderTarget', () => {
  it('classifies Claude, Codex, and the selected OpenCode provider', () => {
    expect(modelProviderTarget(agent('claude'), runtime('claude-agent-acp'))).toEqual({
      provider: 'anthropic',
      runtime: 'claude'
    })
    expect(modelProviderTarget(agent('codex-acp'), runtime('codex-acp'))).toEqual({
      provider: 'openai',
      runtime: 'codex'
    })
    expect(modelProviderTarget(agent('opencode', 'anthropic/claude-sonnet-4'), runtime('opencode', ['acp']))).toEqual({
      provider: 'anthropic',
      runtime: 'opencode',
      opencodeProvider: 'anthropic'
    })
    expect(modelProviderTarget(agent('opencode', 'deepseek/deepseek-v4'), runtime('opencode', ['acp']))).toEqual({
      provider: 'openai',
      runtime: 'opencode',
      opencodeProvider: 'deepseek'
    })
    expect(
      modelProviderTarget(agent('opencode', 'openai/gpt-5'), runtime('opencode', ['acp']), 'anthropic/claude-opus-4')
    ).toEqual({
      provider: 'anthropic',
      runtime: 'opencode',
      opencodeProvider: 'anthropic'
    })
  })
})

describe('applyModelCredential', () => {
  it('uses Claude gateway bearer-token variables', () => {
    const env = { ANTHROPIC_API_KEY: 'old' }
    applyModelCredential({ provider: 'anthropic', runtime: 'claude' }, env, {
      key: 'issued',
      baseUrl: 'https://gateway.example/anthropic'
    })
    expect(env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'issued',
      ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic'
    })
  })

  it('writes Codex base URL through CODEX_CONFIG while preserving existing fields', () => {
    const env = { CODEX_CONFIG: JSON.stringify({ features: { apps: false } }) }
    applyModelCredential({ provider: 'openai', runtime: 'codex' }, env, {
      key: 'issued',
      baseUrl: 'https://gateway.example/openai/v1'
    })
    expect(env.OPENAI_API_KEY).toBe('issued')
    expect(env.OPENAI_BASE_URL).toBe('https://gateway.example/openai/v1')
    expect(JSON.parse(env.CODEX_CONFIG)).toEqual({
      features: { apps: false },
      model_provider: 'openai',
      openai_base_url: 'https://gateway.example/openai/v1'
    })
  })

  it('overlays only the selected OpenCode provider and references the token environment', () => {
    const env = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { deepseek: { options: { timeout: 30_000 } } } })
    }
    applyModelCredential({ provider: 'openai', runtime: 'opencode', opencodeProvider: 'deepseek' }, env, {
      key: 'issued',
      baseUrl: 'https://gateway.example/openai/v1'
    })
    expect(env.MODEL_TOKEN).toBe('issued')
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      provider: {
        deepseek: {
          options: {
            timeout: 30_000,
            apiKey: '{env:MODEL_TOKEN}',
            baseURL: 'https://gateway.example/openai/v1'
          }
        }
      }
    })
  })

  it('supports a static URL without replacing the runtime key', () => {
    const env = { OPENAI_API_KEY: 'runtime-key' }
    applyStaticModelConfig({ provider: 'openai', runtime: 'codex' }, env, {
      key: '',
      baseUrl: 'https://gateway.example/openai/v1'
    })
    expect(env.OPENAI_API_KEY).toBe('runtime-key')
    expect(JSON.parse(env.CODEX_CONFIG)).toMatchObject({
      model_provider: 'openai',
      openai_base_url: 'https://gateway.example/openai/v1'
    })
  })

  it('rejects a non-HTTP static gateway URL', () => {
    expect(() => configuredModelCredentials({ MODEL_BASE_URL: 'file:///tmp/provider' })).toThrow(/http\(s\)/)
    expect(() => configuredModelCredentials({ ANTHROPIC_MODEL_BASE_URL: 'file:///tmp/provider' })).toThrow(
      /ANTHROPIC_MODEL_BASE_URL must be an http\(s\) URL/
    )
  })

  it('reads the shared static pair for every runtime', () => {
    expect(configuredModelCredentials({ MODEL_TOKEN: 'k', MODEL_BASE_URL: 'https://gw.example' })).toEqual({
      claude: { key: 'k', baseUrl: 'https://gw.example' },
      codex: { key: 'k', baseUrl: 'https://gw.example' },
      opencode: { key: 'k', baseUrl: 'https://gw.example' },
      deepseek: { key: 'k', baseUrl: 'https://gw.example' }
    })
  })

  it('lets each runtime carry the base its own dialect needs', () => {
    expect(
      configuredModelCredentials({
        MODEL_TOKEN: 'gw-token',
        ANTHROPIC_MODEL_BASE_URL: 'https://gw.example',
        ANTHROPIC_MODEL_TOKEN: 'gw-token',
        OPENAI_MODEL_BASE_URL: 'https://gw.example/v1',
        OPENAI_MODEL_TOKEN: 'gw-token',
        DEEPSEEK_MODEL_BASE_URL: 'https://gw.example/deepseek/v1',
        DEEPSEEK_MODEL_TOKEN: 'gw-token'
      })
    ).toEqual({
      claude: { key: 'gw-token', baseUrl: 'https://gw.example' },
      codex: { key: 'gw-token', baseUrl: 'https://gw.example/v1' },
      opencode: { key: 'gw-token' },
      deepseek: { key: 'gw-token', baseUrl: 'https://gw.example/deepseek/v1' }
    })
  })

  it('replaces the shared pair whole rather than merging into it', () => {
    expect(
      configuredModelCredentials({
        MODEL_TOKEN: 'shared',
        MODEL_BASE_URL: 'https://shared.example',
        ANTHROPIC_MODEL_BASE_URL: 'https://gw.example'
      })
    ).toMatchObject({
      // The scoped pair carries no key, so nothing of the shared pair survives into it.
      claude: { key: '', baseUrl: 'https://gw.example' },
      codex: { key: 'shared', baseUrl: 'https://shared.example' }
    })
  })

  it('is undefined when nothing is configured', () => {
    expect(configuredModelCredentials({})).toBeUndefined()
  })

  it('aims a deepseek runtime at its own provider variables', () => {
    const env: Record<string, string> = {}
    applyModelCredential({ provider: 'deepseek', runtime: 'deepseek' }, env, {
      key: 'dsh-key',
      baseUrl: 'https://gw.example/deepseek/v1'
    })
    expect(env).toEqual({ DEEPSEEK_API_KEY: 'dsh-key', DEEPSEEK_BASE_URL: 'https://gw.example/deepseek/v1' })
  })

  it('targets the deepseek harness by its dsh-acp bin', () => {
    expect(
      modelProviderTarget(
        { runtime: 'dsh-acp' } as never,
        {
          command: 'npx',
          args: ['-y', '-p', '@openma/deepseek-harness-acp@^0.4', 'dsh-acp'],
          env: []
        } as never
      )
    ).toEqual({ provider: 'deepseek', runtime: 'deepseek' })
  })
})
