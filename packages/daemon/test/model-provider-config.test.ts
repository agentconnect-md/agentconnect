import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/agents/agent-schema.js'
import type { RuntimeDef } from '../src/config/config-schema.js'
import {
  applyModelCredential,
  applyStaticModelConfig,
  configuredModelCredential,
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
      model_providers: {
        openai: {
          name: 'OpenAI',
          base_url: 'https://gateway.example/openai/v1',
          env_key: 'OPENAI_API_KEY'
        }
      }
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
      model_providers: { openai: { base_url: 'https://gateway.example/openai/v1' } }
    })
  })

  it('rejects a non-HTTP static gateway URL', () => {
    expect(() => configuredModelCredential({ MODEL_BASE_URL: 'file:///tmp/provider' })).toThrow(/http\(s\)/)
  })
})
