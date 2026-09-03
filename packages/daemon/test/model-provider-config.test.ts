import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/agents/agent-schema.js'
import type { RuntimeDef } from '../src/config/config-schema.js'
import {
  applyCodexSessionFloor,
  applyModelCredential,
  applyStaticModelConfig,
  applyClaudeModelAliases,
  configuredClaudeModelAliases,
  configuredCodexSessionFloor,
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
  it('writes the Claude key slot and clears any bearer-token variable', () => {
    // Both stale variables present: exactly one credential may survive, in the x-api-key slot —
    // the same slot the sandbox shim's AC_CLAUDE_API_KEY fill-in targets, so it stays blocked.
    const env = { ANTHROPIC_API_KEY: 'old', ANTHROPIC_AUTH_TOKEN: 'old-bearer' }
    applyModelCredential({ provider: 'anthropic', runtime: 'claude' }, env, {
      key: 'issued',
      baseUrl: 'https://gateway.example/anthropic'
    })
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'issued',
      ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic'
    })
  })

  it('writes Codex base URL through CODEX_CONFIG while preserving existing fields', () => {
    const env: Record<string, string> = { CODEX_CONFIG: JSON.stringify({ features: { apps: false } }) }
    applyModelCredential({ provider: 'openai', runtime: 'codex' }, env, {
      key: 'issued',
      baseUrl: 'https://gateway.example/openai/v1'
    })
    expect(env.OPENAI_API_KEY).toBe('issued')
    // An endpoint-carrying credential authenticates as a GATEWAY: process-ephemeral, so no
    // persisted account can override this launch's grant and concurrent hosts share nothing.
    expect(JSON.parse(env.DEFAULT_AUTH_REQUEST!)).toEqual({
      methodId: 'gateway',
      _meta: {
        gateway: {
          baseUrl: 'https://gateway.example/openai/v1',
          headers: { Authorization: 'Bearer issued' },
          providerName: 'AgentConnect model egress'
        }
      }
    })
    expect(env.OPENAI_BASE_URL).toBe('https://gateway.example/openai/v1')
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({
      features: { apps: false },
      model_provider: 'openai',
      openai_base_url: 'https://gateway.example/openai/v1'
    })
  })

  it('overlays only the selected OpenCode provider and references the token environment', () => {
    const env: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { deepseek: { options: { timeout: 30_000 } } } })
    }
    applyModelCredential({ provider: 'openai', runtime: 'opencode', opencodeProvider: 'deepseek' }, env, {
      key: 'issued',
      baseUrl: 'https://gateway.example/openai/v1'
    })
    expect(env.MODEL_TOKEN).toBe('issued')
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
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
    const env: Record<string, string> = { OPENAI_API_KEY: 'runtime-key' }
    applyStaticModelConfig({ provider: 'openai', runtime: 'codex' }, env, {
      key: '',
      baseUrl: 'https://gateway.example/openai/v1'
    })
    expect(env.OPENAI_API_KEY).toBe('runtime-key')
    expect(JSON.parse(env.CODEX_CONFIG!)).toMatchObject({
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

describe('applyModelCredential codex auth request', () => {
  it('sends no auth request for an endpoint-less key — the shim owns the effective endpoint', () => {
    // The key-server contract supports a plain vault rotating real provider keys with no base
    // URL, and the pod's AC_CODEX_BASE_URL floor outranks the runtime default endpoint. Only the
    // shim can see that floor, so the daemon must not pre-compose a request that would send the
    // issued key past it to public OpenAI.
    const env: Record<string, string> = {}
    applyModelCredential({ provider: 'openai', runtime: 'codex' }, env, { key: 'real-provider-key' })
    expect(env).toEqual({ OPENAI_API_KEY: 'real-provider-key' })
  })
})

describe('applyCodexSessionFloor', () => {
  const codex = { provider: 'openai', runtime: 'codex' } as const
  const floor = JSON.stringify({ features: { multi_agent: false }, model: 'gpt-5.5' })

  it('merges the floor under every key the daemon already authored', () => {
    const env: Record<string, string> = {}
    applyModelCredential(codex, env, { key: 'k', baseUrl: 'https://gw.example/v1' })
    applyCodexSessionFloor(codex, env, floor)
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({
      model_provider: 'openai',
      openai_base_url: 'https://gw.example/v1',
      features: { multi_agent: false },
      model: 'gpt-5.5'
    })
  })

  it('keeps daemon-sent leaves authoritative, merging shared tables one level deep', () => {
    const env: Record<string, string> = { CODEX_CONFIG: JSON.stringify({ model: 'o3-mini', features: { web: true } }) }
    applyCodexSessionFloor(codex, env, floor)
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({ model: 'o3-mini', features: { multi_agent: false, web: true } })
  })

  it('applies with no daemon-sent config at all — the stale-sandbox case the daemon channel exists for', () => {
    const env: Record<string, string> = {}
    applyCodexSessionFloor(codex, env, floor)
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({ features: { multi_agent: false }, model: 'gpt-5.5' })
  })

  it('touches no runtime but codex', () => {
    const env: Record<string, string> = {}
    applyCodexSessionFloor({ provider: 'deepseek', runtime: 'deepseek' }, env, floor)
    expect(env).toEqual({})
  })
})

describe('configuredCodexSessionFloor', () => {
  it('returns the raw value once it parses as an object', () => {
    expect(configuredCodexSessionFloor({ AC_CODEX_CONFIG: ' {"model":"gpt-5.5"} ' })).toBe('{"model":"gpt-5.5"}')
  })

  it('is undefined when unset or blank', () => {
    expect(configuredCodexSessionFloor({})).toBeUndefined()
    expect(configuredCodexSessionFloor({ AC_CODEX_CONFIG: '  ' })).toBeUndefined()
  })

  it('fails loudly at boot on a malformed value', () => {
    expect(() => configuredCodexSessionFloor({ AC_CODEX_CONFIG: '[1]' })).toThrow('AC_CODEX_CONFIG')
  })
})

describe('claude model aliases', () => {
  it('collects only the declared alias variables, trimmed', () => {
    expect(
      configuredClaudeModelAliases({
        ANTHROPIC_DEFAULT_FABLE_MODEL: ' claude-fable-5-1 ',
        ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Fable',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '   ',
        ANTHROPIC_API_KEY: 'not-an-alias'
      })
    ).toEqual({ ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1', ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Fable' })
  })

  it('is undefined when the deployment declares nothing', () => {
    expect(configuredClaudeModelAliases({})).toBeUndefined()
  })

  it('writes the declarations onto a claude launch without overwriting a daemon-authored key', () => {
    const env: Record<string, string> = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'daemon-chose-this' }
    applyClaudeModelAliases({ provider: 'anthropic', runtime: 'claude' }, env, {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deployment-default'
    })
    expect(env).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'daemon-chose-this',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1'
    })
  })

  it('touches no runtime but claude', () => {
    const env: Record<string, string> = {}
    applyClaudeModelAliases({ provider: 'openai', runtime: 'codex' }, env, {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1'
    })
    expect(env).toEqual({})
  })
})
