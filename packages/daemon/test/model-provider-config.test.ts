import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/agents/agent-schema.js'
import type { RuntimeDef } from '../src/config/config-schema.js'
import {
  applyCodexSessionFloor,
  applyOrganizationModelCredential,
  applyProxiedOrganizationModelCredential,
  applyConfiguredModelProviders,
  applyKiloLaunchModel,
  applyModelCredential,
  applyStaticModelConfig,
  applyClaudeModelAliases,
  configuredClaudeModelAliases,
  configuredCodexSessionFloor,
  configuredModelCredentials,
  launchModelChoice,
  modelCredentialRuntime,
  modelProviderTarget
} from '../src/runtimes/model-provider-config.js'

const runtime = (command: string, args: string[] = []): RuntimeDef => ({ command, args, env: [] })
const agent = (runtimeId: string, model?: string): Pick<Agent, 'runtime' | 'runtimeOverrides'> => ({
  runtime: runtimeId,
  ...(model ? { runtimeOverrides: { model, env: [], secrets: [] } } : {})
})

describe('organization model credentials', () => {
  it('replaces ambient Claude auth, endpoint and headers without changing the source', () => {
    const source = {
      ANTHROPIC_API_KEY: 'local-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_AUTH_TOKEN: 'local-token',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: local-header'
    }
    const env: Record<string, string> = { ...source }
    applyOrganizationModelCredential('anthropic', { provider: 'anthropic', runtime: 'claude' }, env, {
      apiKey: 'organization-key',
      endpoint: null,
      headers: { 'anthropic-workspace-id': 'example-workspace' }
    })
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'organization-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      ANTHROPIC_CUSTOM_HEADERS: 'anthropic-workspace-id: example-workspace'
    })
    expect(source.ANTHROPIC_API_KEY).toBe('local-key')
    expect(() =>
      applyOrganizationModelCredential('anthropic', { provider: 'openai', runtime: 'codex' }, env, {
        apiKey: 'organization-key',
        endpoint: null,
        headers: {}
      })
    ).toThrow('do not match')
  })

  it('uses ephemeral Codex authentication and preserves the provider headers', () => {
    const env: Record<string, string> = {}
    applyOrganizationModelCredential('openai', { provider: 'openai', runtime: 'codex' }, env, {
      apiKey: 'organization-key',
      endpoint: 'https://gateway.example.test/v1',
      headers: { 'x-route': 'example-route' }
    })
    expect(JSON.parse(env.DEFAULT_AUTH_REQUEST!)).toMatchObject({
      methodId: 'gateway',
      _meta: {
        gateway: {
          baseUrl: 'https://gateway.example.test/v1',
          headers: { Authorization: 'Bearer organization-key', 'x-route': 'example-route' }
        }
      }
    })
  })

  it('automatically binds OpenCode to the selected model provider and rejects unsupported providers', () => {
    const env: Record<string, string> = {}
    const target = modelProviderTarget(agent('opencode', 'anthropic/claude-sonnet-4'), runtime('opencode', ['acp']))
    applyOrganizationModelCredential('auto', target, env, { apiKey: 'example-key', endpoint: null, headers: {} })
    expect(env.ANTHROPIC_API_KEY).toBe('example-key')
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).enabled_providers).toEqual(['anthropic'])
    expect(() =>
      applyOrganizationModelCredential(
        'auto',
        { provider: 'openai', runtime: 'opencode', opencodeProvider: 'openrouter' },
        {},
        { apiKey: 'example-key', endpoint: null, headers: {} }
      )
    ).toThrow(/do not match/)
  })
})

describe('proxied organization model credentials', () => {
  const PLACEHOLDER = 'acph1_example.placeholder'
  const credential = { apiKey: 'organization-key', endpoint: null, headers: { 'x-route': 'example-route' } }
  const leaks = (env: Record<string, string>) => {
    expect(JSON.stringify(env)).not.toContain('organization-key')
    expect(JSON.stringify(env)).not.toContain('example-route')
  }

  it("puts the placeholder in Claude's key variable and leaves its headers to the proxy", () => {
    const env: Record<string, string> = { ANTHROPIC_CUSTOM_HEADERS: 'x-route: local-route' }
    applyProxiedOrganizationModelCredential(
      'anthropic',
      { provider: 'anthropic', runtime: 'claude' },
      env,
      credential,
      PLACEHOLDER
    )
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: PLACEHOLDER,
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_CUSTOM_HEADERS: ''
    })
    leaks(env)
  })

  it("puts the placeholder in Codex's key and auth request, with no header values", () => {
    const env: Record<string, string> = {}
    applyProxiedOrganizationModelCredential(
      'openai',
      { provider: 'openai', runtime: 'codex' },
      env,
      { ...credential, endpoint: 'https://gateway.example.test/v1' },
      PLACEHOLDER
    )
    expect(env.OPENAI_API_KEY).toBe(PLACEHOLDER)
    expect(JSON.parse(env.DEFAULT_AUTH_REQUEST!)._meta.gateway).toMatchObject({
      baseUrl: 'https://gateway.example.test/v1',
      headers: { Authorization: `Bearer ${PLACEHOLDER}` }
    })
    leaks(env)
  })

  it("puts the placeholder in OpenCode's key variable and a launch-model runtime's, which then need no header support", () => {
    const opencode: Record<string, string> = {}
    const target = modelProviderTarget(agent('opencode', 'anthropic/claude-sonnet-4'), runtime('opencode', ['acp']))
    applyProxiedOrganizationModelCredential('auto', target, opencode, credential, PLACEHOLDER)
    expect(opencode.ANTHROPIC_API_KEY).toBe(PLACEHOLDER)
    expect(JSON.parse(opencode.OPENCODE_CONFIG_CONTENT!).provider.anthropic.options.headers).toEqual({})
    leaks(opencode)
    const goose: Record<string, string> = {}
    applyProxiedOrganizationModelCredential(
      'openai',
      { provider: 'openai', runtime: 'goose', model: 'gpt-5' },
      goose,
      credential,
      PLACEHOLDER
    )
    expect(goose).toMatchObject({ OPENAI_API_KEY: PLACEHOLDER, OPENAI_BASE_URL: 'https://api.openai.com/v1' })
    leaks(goose)
  })
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
      provider: 'deepseek',
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
    applyModelCredential({ provider: 'deepseek', runtime: 'opencode', opencodeProvider: 'deepseek' }, env, {
      key: 'issued',
      baseUrl: 'https://gateway.example/deepseek/anthropic'
    })
    expect(env.DEEPSEEK_API_KEY).toBe('issued')
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      provider: {
        deepseek: {
          npm: '@ai-sdk/anthropic',
          options: {
            timeout: 30_000,
            apiKey: '{env:DEEPSEEK_API_KEY}',
            baseURL: 'https://gateway.example/deepseek/anthropic/v1'
          }
        }
      }
    })
  })

  it("speaks the DeepSeek Harness's Messages dialect only to a deepseek base it was given", () => {
    const keyOnly: Record<string, string> = {}
    applyModelCredential({ provider: 'deepseek', runtime: 'opencode', opencodeProvider: 'deepseek' }, keyOnly, {
      key: 'direct'
    })
    expect(JSON.parse(keyOnly.OPENCODE_CONFIG_CONTENT!).provider.deepseek).toEqual({
      options: { apiKey: '{env:DEEPSEEK_API_KEY}' }
    })
    const operatorPackage: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { deepseek: { npm: '@ai-sdk/openai-compatible' } } })
    }
    applyModelCredential({ provider: 'deepseek', runtime: 'opencode', opencodeProvider: 'deepseek' }, operatorPackage, {
      key: 'issued',
      baseUrl: 'https://gateway.example/deepseek/v1/'
    })
    expect(JSON.parse(operatorPackage.OPENCODE_CONFIG_CONTENT!).provider.deepseek).toEqual({
      npm: '@ai-sdk/openai-compatible',
      options: { apiKey: '{env:DEEPSEEK_API_KEY}', baseURL: 'https://gateway.example/deepseek/v1' }
    })
  })

  it('keeps OpenCode provider keys separate and preserves explicit model restrictions', () => {
    const env: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        enabled_providers: ['anthropic', 'openai'],
        provider: { anthropic: { whitelist: ['claude-sonnet-4'], options: { timeout: 30_000 } } }
      })
    }
    const credentials = {
      anthropic: { key: 'claude-key', baseUrl: 'https://gw.example/anthropic/' },
      openai: { key: 'openai-key', baseUrl: 'https://gw.example/openai/v1' },
      deepseek: { key: 'deepseek-key', baseUrl: 'https://gw.example/deepseek/v1' }
    }
    applyConfiguredModelProviders(
      { runtime: 'opencode', provider: 'openai' },
      env,
      (target) => credentials[target.opencodeProvider as keyof typeof credentials]
    )
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'claude-key',
      OPENAI_API_KEY: 'openai-key',
      DEEPSEEK_API_KEY: 'deepseek-key'
    })
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
    expect(config.enabled_providers).toEqual(['anthropic', 'openai'])
    expect(config.provider.anthropic).toEqual({
      whitelist: ['claude-sonnet-4'],
      options: { timeout: 30_000, apiKey: '{env:ANTHROPIC_API_KEY}', baseURL: 'https://gw.example/anthropic/v1' }
    })
    expect(config.provider.openai.options.apiKey).toBe('{env:OPENAI_API_KEY}')
    expect(config.provider.deepseek).toEqual({
      npm: '@ai-sdk/anthropic',
      options: { apiKey: '{env:DEEPSEEK_API_KEY}', baseURL: 'https://gw.example/deepseek/v1' }
    })
    applyStaticModelConfig({ runtime: 'opencode', provider: 'anthropic', opencodeProvider: 'anthropic' }, env, {
      key: '',
      baseUrl: 'https://gw.example/anthropic/v1/'
    })
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).provider.anthropic.options.baseURL).toBe(
      'https://gw.example/anthropic/v1'
    )
    expect(env.ANTHROPIC_API_KEY).toBe('claude-key')
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

describe('Kilo, Qwen Code, Copilot and goose', () => {
  const anthropicPair = { key: 'issued', baseUrl: 'https://gw.example/anthropic' }
  const openaiPair = { key: 'issued', baseUrl: 'https://gw.example/openai/v1' }

  it('recognises each runtime by registry id or launch and takes the dialect from the model', () => {
    expect(modelProviderTarget(agent('kilo', 'anthropic/claude-sonnet-5-5'), runtime('./kilo', ['acp']))).toEqual({
      provider: 'anthropic',
      runtime: 'kilo',
      opencodeProvider: 'anthropic'
    })
    expect(modelProviderTarget(agent('custom'), runtime('npx', ['-y', '@kilocode/cli@7.8.27', 'acp']))).toMatchObject({
      runtime: 'kilo',
      opencodeProvider: 'openai'
    })
    expect(
      modelProviderTarget(agent('qwen-code', '$runtime|anthropic|claude-sonnet-5-5(anthropic)'), runtime('qwen'))
    ).toEqual({ provider: 'anthropic', runtime: 'qwen', model: 'claude-sonnet-5-5' })
    expect(modelProviderTarget(agent('custom', 'gpt-5.5'), runtime('npx', ['@qwen-code/qwen-code@0.26.8']))).toEqual({
      provider: 'openai',
      runtime: 'qwen',
      model: 'gpt-5.5'
    })
    expect(
      modelProviderTarget(agent('custom', 'claude-opus-5-5'), runtime('npx', ['@github/copilot@1.0.106']))
    ).toEqual({ provider: 'anthropic', runtime: 'copilot', model: 'claude-opus-5-5' })
    expect(modelProviderTarget(agent('goose'), runtime('./goose', ['acp']))).toEqual({
      provider: 'openai',
      runtime: 'goose'
    })
    expect(modelProviderTarget(agent('gemini'), runtime('gemini', ['--acp']))).toBeUndefined()
    // Kilo's built-in deepseek provider speaks chat completions, which the Messages-only deepseek pair refuses.
    expect(modelProviderTarget(agent('kilo', 'deepseek/deepseek-chat'), runtime('./kilo', ['acp']))).toBeUndefined()
  })

  it('reads explicit, Qwen-advertised and bare model ids', () => {
    expect(launchModelChoice('openai/claude-like')).toEqual({ provider: 'openai', model: 'claude-like' })
    expect(launchModelChoice('$runtime|openai|gpt-5.5(openai)')).toEqual({ provider: 'openai', model: 'gpt-5.5' })
    expect(launchModelChoice('Claude-Haiku-5-5')).toEqual({ provider: 'anthropic', model: 'Claude-Haiku-5-5' })
    expect(launchModelChoice('auto')).toEqual({ provider: 'openai' })
    expect(launchModelChoice(undefined)).toEqual({ provider: 'openai' })
  })

  it('reuses the Claude and Codex pairs for the dialect each launch speaks', () => {
    expect(modelCredentialRuntime({ provider: 'anthropic', runtime: 'goose', model: 'claude-x' })).toBe('claude')
    expect(modelCredentialRuntime({ provider: 'openai', runtime: 'copilot', model: 'gpt-5.5' })).toBe('codex')
  })

  it('writes Kilo through KILO_CONFIG_CONTENT and limits it to the configured providers', () => {
    const env: Record<string, string> = { KILO_CONFIG_CONTENT: JSON.stringify({ share: 'disabled' }) }
    const pairs = { anthropic: anthropicPair, openai: openaiPair, deepseek: openaiPair }
    applyConfiguredModelProviders(
      { provider: 'anthropic', runtime: 'kilo', opencodeProvider: 'anthropic' },
      env,
      (target) => pairs[target.opencodeProvider as keyof typeof pairs]
    )
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    expect(env).toMatchObject({ ANTHROPIC_API_KEY: 'issued', OPENAI_API_KEY: 'issued' })
    expect(JSON.parse(env.KILO_CONFIG_CONTENT!)).toEqual({
      share: 'disabled',
      provider: {
        anthropic: { options: { apiKey: '{env:ANTHROPIC_API_KEY}', baseURL: 'https://gw.example/anthropic/v1' } },
        openai: { options: { apiKey: '{env:OPENAI_API_KEY}', baseURL: 'https://gw.example/openai/v1' } }
      },
      enabled_providers: ['anthropic', 'openai']
    })
  })

  it('pins Kilo to the launch model, never over one the deployment chose', () => {
    const target = { provider: 'openai', runtime: 'kilo', opencodeProvider: 'openai' } as const
    const env: Record<string, string> = {}
    applyKiloLaunchModel(target, env, 'openai/gpt-5.5')
    expect(JSON.parse(env.KILO_CONFIG_CONTENT!).model).toBe('openai/gpt-5.5')
    applyKiloLaunchModel(target, env, 'anthropic/claude-x')
    expect(JSON.parse(env.KILO_CONFIG_CONTENT!).model).toBe('openai/gpt-5.5')
    const opencode: Record<string, string> = {}
    applyKiloLaunchModel({ ...target, runtime: 'opencode' }, opencode, 'openai/gpt-5.5')
    expect(opencode).toEqual({})
  })

  it('gives Qwen Code one complete variable triple for the selected dialect', () => {
    const openai: Record<string, string> = {}
    applyModelCredential({ provider: 'openai', runtime: 'qwen', model: 'gpt-5.5' }, openai, openaiPair)
    expect(openai).toEqual({
      OPENAI_API_KEY: 'issued',
      OPENAI_BASE_URL: 'https://gw.example/openai/v1',
      OPENAI_MODEL: 'gpt-5.5',
      QWEN_USAGE_STATISTICS_ENABLED: 'false'
    })
    // Qwen checks the OpenAI triple first, so an Anthropic launch empties its model variables.
    const anthropic: Record<string, string> = { OPENAI_MODEL: 'stale', QWEN_USAGE_STATISTICS_ENABLED: 'true' }
    applyModelCredential({ provider: 'anthropic', runtime: 'qwen', model: 'claude-x' }, anthropic, anthropicPair)
    expect(anthropic).toEqual({
      ANTHROPIC_API_KEY: 'issued',
      ANTHROPIC_BASE_URL: 'https://gw.example/anthropic',
      ANTHROPIC_MODEL: 'claude-x',
      OPENAI_MODEL: '',
      QWEN_MODEL: '',
      QWEN_USAGE_STATISTICS_ENABLED: 'true'
    })
  })

  it('sets Copilot to its provider mode with the model it requires', () => {
    const env: Record<string, string> = {}
    applyModelCredential({ provider: 'anthropic', runtime: 'copilot', model: 'claude-x' }, env, anthropicPair)
    expect(env).toEqual({
      COPILOT_PROVIDER_TYPE: 'anthropic',
      COPILOT_PROVIDER_API_KEY: 'issued',
      COPILOT_PROVIDER_BASE_URL: 'https://gw.example/anthropic',
      COPILOT_MODEL: 'claude-x',
      COPILOT_OFFLINE: 'true'
    })
  })

  it('sets goose to the provider, host and model of the selected dialect', () => {
    const anthropic: Record<string, string> = {}
    applyModelCredential({ provider: 'anthropic', runtime: 'goose', model: 'claude-x' }, anthropic, anthropicPair)
    expect(anthropic).toEqual({
      GOOSE_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'issued',
      ANTHROPIC_HOST: 'https://gw.example/anthropic',
      GOOSE_MODEL: 'claude-x',
      GOOSE_DISABLE_KEYRING: '1'
    })
    const openai: Record<string, string> = {}
    applyModelCredential({ provider: 'openai', runtime: 'goose', model: 'gpt-5.5' }, openai, openaiPair)
    expect(openai).toMatchObject({ GOOSE_PROVIDER: 'openai', OPENAI_BASE_URL: 'https://gw.example/openai/v1' })
  })

  it('takes the dialect from the model the deployment named when no session model is known', () => {
    const env: Record<string, string> = { COPILOT_MODEL: 'claude-x' }
    const asked: string[] = []
    applyConfiguredModelProviders({ provider: 'openai', runtime: 'copilot' }, env, (target) => {
      asked.push(target.provider)
      return target.provider === 'anthropic' ? anthropicPair : openaiPair
    })
    expect(asked).toEqual(['anthropic'])
    expect(env).toMatchObject({
      COPILOT_PROVIDER_TYPE: 'anthropic',
      COPILOT_PROVIDER_BASE_URL: 'https://gw.example/anthropic'
    })
    const qwen: Record<string, string> = { ANTHROPIC_MODEL: 'claude-x' }
    applyConfiguredModelProviders({ provider: 'openai', runtime: 'qwen' }, qwen, (target) =>
      target.provider === 'anthropic' ? anthropicPair : undefined
    )
    expect(qwen).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gw.example/anthropic', ANTHROPIC_MODEL: 'claude-x' })
  })

  it('keeps the runtime key under a URL-only static pair', () => {
    const env: Record<string, string> = { OPENAI_API_KEY: 'runtime-key' }
    applyStaticModelConfig({ provider: 'openai', runtime: 'goose', model: 'gpt-5.5' }, env, {
      key: '',
      baseUrl: 'https://gw.example/openai/v1'
    })
    expect(env).toMatchObject({ OPENAI_API_KEY: 'runtime-key', OPENAI_BASE_URL: 'https://gw.example/openai/v1' })
  })

  it('refuses organization credentials whose headers the runtime cannot send', () => {
    expect(() =>
      applyOrganizationModelCredential(
        'anthropic',
        { provider: 'anthropic', runtime: 'goose', model: 'claude-x' },
        {},
        { apiKey: 'k', endpoint: null, headers: { 'anthropic-workspace-id': 'example-workspace' } }
      )
    ).toThrow(/cannot send/)
    const env: Record<string, string> = {}
    applyOrganizationModelCredential(
      'auto',
      { provider: 'anthropic', runtime: 'kilo', opencodeProvider: 'anthropic' },
      env,
      {
        apiKey: 'k',
        endpoint: null,
        headers: {}
      }
    )
    expect(JSON.parse(env.KILO_CONFIG_CONTENT!).enabled_providers).toEqual(['anthropic'])
  })
})
