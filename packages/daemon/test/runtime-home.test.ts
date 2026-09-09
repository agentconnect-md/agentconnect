import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { hostPackageCacheEnv, prepareRuntimeHome, runtimeHomeEnvironment } from '../src/runtimes/runtime-home.js'
import { extractOmpCredentials } from '../src/runtimes/omp-credentials.js'
import { discoverSeededRuntimeCredentials } from '../src/runtimes/runtime-seeded-credentials.js'

function fixture(): { root: string; hostHome: string; scopeDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'ac-runtime-home-'))
  const hostHome = join(root, 'host')
  const scopeDir = join(root, 'agent')
  mkdirSync(join(hostHome, '.claude', 'sessions'), { recursive: true })
  mkdirSync(scopeDir)
  return { root, hostHome, scopeDir }
}

describe('private runtime HOME', () => {
  it('seeds only Claude model rollout cache and keeps other host state out', () => {
    const { hostHome, scopeDir } = fixture()
    writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"token":"host"}')
    writeFileSync(join(hostHome, '.claude', 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(hostHome, '.claude', 'state.sqlite'), 'do-not-copy')
    writeFileSync(join(hostHome, '.claude', 'sessions', 'old.json'), '{"old":true}')
    writeFileSync(
      join(hostHome, '.claude.json'),
      JSON.stringify({
        additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]', label: 'Fable', description: 'test' }],
        mcpServers: { private: { token: 'do-not-copy' } },
        projects: { '/host/private': { allowedTools: [] } },
        oauthAccount: { emailAddress: 'do-not-copy@example.test' }
      })
    )

    const home = prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    expect(existsSync(join(home, '.claude', '.credentials.json'))).toBe(false)
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({
      additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]', label: 'Fable', description: 'test' }]
    })
    // Global config also lands in CLAUDE_CONFIG_DIR (<home>/.claude), which is
    // where a CLAUDE_CONFIG_DIR-pinned Claude Code actually reads it (the feature
    // cache there gates newer models like Fable 5).
    expect(JSON.parse(readFileSync(join(home, '.claude', '.claude.json'), 'utf8'))).toEqual({
      additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]', label: 'Fable', description: 'test' }]
    })
    expect(existsSync(join(home, '.claude', 'state.sqlite'))).toBe(false)
    expect(existsSync(join(home, '.claude', 'sessions'))).toBe(false)
  })

  it('leaves Claude cold when the host global config has no model rollout cache', () => {
    const { hostHome, scopeDir } = fixture()
    writeFileSync(join(hostHome, '.claude.json'), JSON.stringify({ mcpServers: { private: {} } }))

    const home = prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
    expect(existsSync(join(home, '.claude', '.claude.json'))).toBe(false)
  })

  it('projects the active Claude file-login API key without host account or MCP state', () => {
    const { hostHome, scopeDir } = fixture()
    const config = join(hostHome, '.claude')
    writeFileSync(
      join(config, '.config.json'),
      JSON.stringify({ primaryApiKey: 'synthetic-key', oauthAccount: { id: 'private' }, mcpServers: { private: {} } })
    )
    writeFileSync(join(hostHome, '.claude.json'), JSON.stringify({ primaryApiKey: 'ignored-key' }))
    const home = prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    expect(JSON.parse(readFileSync(join(home, '.claude', '.config.json'), 'utf8'))).toEqual({
      primaryApiKey: 'synthetic-key'
    })
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
  })

  it('fills a missing saved Claude API key in retained private config without replacing private settings', () => {
    const { hostHome, scopeDir } = fixture()
    const hostConfig = join(hostHome, '.claude.json')
    writeFileSync(hostConfig, JSON.stringify({ additionalModelOptionsCache: ['initial'] }))
    const home = prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    const privateConfig = join(home, '.claude', '.claude.json')
    writeFileSync(privateConfig, JSON.stringify({ additionalModelOptionsCache: ['private'], localSetting: true }))
    writeFileSync(hostConfig, JSON.stringify({ primaryApiKey: 'synthetic-key', additionalModelOptionsCache: [] }))
    prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    expect(JSON.parse(readFileSync(privateConfig, 'utf8'))).toEqual({
      additionalModelOptionsCache: ['private'],
      localSetting: true,
      primaryApiKey: 'synthetic-key'
    })
    writeFileSync(hostConfig, JSON.stringify({ primaryApiKey: 'another-synthetic-key' }))
    prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    expect(JSON.parse(readFileSync(privateConfig, 'utf8')).primaryApiKey).toBe('synthetic-key')
  })

  it.each([
    {
      runtime: 'grok-build',
      path: join('.grok', 'auth.json'),
      credential: {
        'xai::api_key': { key: 'synthetic-key', auth_mode: 'api_key', expires_at: '2000-01-01T00:00:00Z' }
      },
      provider: 'xai'
    },
    {
      runtime: 'pi-acp',
      path: join('.pi', 'agent', 'auth.json'),
      credential: {
        anthropic: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 1 }
      },
      provider: 'anthropic'
    },
    {
      runtime: 'opencode',
      path: join('.local', 'share', 'opencode', 'auth.json'),
      credential: { openai: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 1 } },
      provider: 'openai'
    },
    {
      runtime: 'qwen-code',
      path: join('.qwen', 'settings.json'),
      credential: {
        modelProviders: { openai: [{ id: 'example-model', envKey: 'EXAMPLE_MODEL_KEY' }] },
        env: { EXAMPLE_MODEL_KEY: 'synthetic-key' }
      },
      provider: 'openai'
    },
    {
      runtime: 'antigravity-acp',
      path: join('.gemini', 'antigravity-acp', 'acp_token.json'),
      credential: { refresh_token: 'synthetic-refresh', client_id: 'synthetic-client', client_secret: 'synthetic' },
      provider: 'google'
    },
    {
      runtime: 'antigravity-acp',
      path: join('.gemini', 'antigravity-acp', 'acp_business_token.json'),
      credential: { refresh_token: 'synthetic-refresh', client_id: 'synthetic-client', client_secret: 'synthetic' },
      provider: 'google'
    },
    {
      runtime: 'auggie',
      path: join('.augment', 'session.json'),
      credential: { accessToken: 'synthetic', tenantURL: 'https://tenant.example.test', scopes: [] },
      provider: 'augment'
    },
    {
      runtime: 'amp-acp',
      path: join('.local', 'share', 'amp', 'secrets.json'),
      credential: { 'apiKey@https://amp.example.test': 'synthetic' },
      provider: 'amp'
    },
    {
      runtime: 'cline',
      path: join('.cline', 'data', 'settings', 'providers.json'),
      credential: {
        version: 1,
        providers: { custom: { settings: { provider: 'anthropic', auth: { accessToken: 'synthetic', expiresAt: 1 } } } }
      },
      provider: 'anthropic'
    },
    {
      runtime: 'hermes-agent',
      path: join('.hermes', 'auth.json'),
      credential: { providers: { 'openai-codex': { tokens: { access_token: 'synthetic', expires_at: 1 } } } },
      provider: 'openai-codex'
    },
    {
      runtime: 'hermes-agent',
      path: join('.hermes', '.anthropic_oauth.json'),
      credential: { refreshToken: 'synthetic', expiresAt: 1 },
      provider: 'anthropic'
    },
    {
      runtime: 'kimi',
      path: join('.kimi-code', 'credentials', 'kimi-code.json'),
      credential: { access_token: 'synthetic', expires_at: 1 },
      provider: 'kimi-code'
    },
    {
      runtime: 'kimi',
      path: join('.kimi', 'credentials', 'kimi-code.json'),
      credential: { refresh_token: 'synthetic', expires_at: 1 },
      provider: 'kimi-code'
    }
  ])(
    'discovers $runtime records from the same exact file seeded into HOME without checking expiry',
    ({ runtime, path, credential, provider }) => {
      const { hostHome, scopeDir } = fixture()
      const source = join(hostHome, path)
      mkdirSync(join(source, '..'), { recursive: true })
      expect(discoverSeededRuntimeCredentials(runtime, { HOME: hostHome })).toEqual({ paths: [], providers: [] })
      writeFileSync(source, '{}')
      expect(discoverSeededRuntimeCredentials(runtime, { HOME: hostHome })).toEqual({ paths: [], providers: [] })
      writeFileSync(source, JSON.stringify(credential))
      expect(discoverSeededRuntimeCredentials(runtime, { HOME: hostHome })).toEqual({
        paths: [source],
        providers: [provider]
      })
      const home = prepareRuntimeHome(runtime, scopeDir, { HOME: hostHome })
      expect(JSON.parse(readFileSync(join(home, path), 'utf8'))).toEqual(credential)
    }
  )

  it('requires a stored Qwen key for the corresponding model provider or selected auth type', () => {
    const { hostHome, scopeDir } = fixture()
    const source = join(hostHome, '.qwen', 'settings.json')
    mkdirSync(join(hostHome, '.qwen'))
    const settings = {
      modelProviders: {
        openai: [{ id: 'example-model', envKey: 'EXAMPLE_MODEL_KEY' }],
        anthropic: [{ id: 'example-model', envKey: 'MISSING_MODEL_KEY', apiKey: 'unsupported-field' }]
      },
      env: { UNRELATED_SERVICE_KEY: 'synthetic-service-key' } as Record<string, string>,
      security: { auth: { selectedType: 'openai', apiKey: '' } }
    }
    writeFileSync(source, JSON.stringify(settings))
    expect(discoverSeededRuntimeCredentials('qwen-code', { HOME: hostHome })).toEqual({ paths: [], providers: [] })
    settings.env.EXAMPLE_MODEL_KEY = 'synthetic-model-key'
    writeFileSync(source, JSON.stringify(settings))
    expect(discoverSeededRuntimeCredentials('qwen-code', { HOME: hostHome })).toEqual({
      paths: [source],
      providers: ['openai']
    })
    settings.security.auth = { selectedType: 'gemini', apiKey: 'synthetic-saved-key' }
    const text = '// Qwen settings\n' + JSON.stringify(settings)
    writeFileSync(source, text)
    expect(discoverSeededRuntimeCredentials('qwen-code', { HOME: hostHome })).toEqual({
      paths: [source],
      providers: ['openai', 'gemini']
    })
    const home = prepareRuntimeHome('qwen-code', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.qwen', 'settings.json'), 'utf8')).toBe(text)
  })

  it('discovers Copilot JSONC token records without treating account identities as logins', () => {
    const { hostHome, scopeDir } = fixture()
    const source = join(hostHome, '.copilot', 'config.json')
    mkdirSync(join(hostHome, '.copilot'))
    const settings = {
      loggedInUsers: [{ host: 'https://github.example.test', login: 'example-user' }],
      copilotTokens: { empty: '', whitespace: '  ', invalid: { token: 'unsupported-field' } } as Record<string, unknown>
    }
    const text = () => '// Managed Copilot configuration\n' + JSON.stringify(settings)
    writeFileSync(source, text())
    expect(discoverSeededRuntimeCredentials('github-copilot-cli', { HOME: hostHome }).paths).toEqual([])
    settings.copilotTokens['example-user'] = 'synthetic-token'
    writeFileSync(source, text())
    expect(discoverSeededRuntimeCredentials('github-copilot-cli', { HOME: hostHome })).toEqual({
      paths: [source],
      providers: ['github-copilot']
    })
    const home = prepareRuntimeHome('github-copilot-cli', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.copilot', 'config.json'), 'utf8')).toBe(text())
    writeFileSync(source, text() + ' invalid-json')
    expect(discoverSeededRuntimeCredentials('github-copilot-cli', { HOME: hostHome }).paths).toEqual([])
  })

  it('finds the Devin TOML API key in the active data directory without counting endpoint configuration', () => {
    const { root, hostHome, scopeDir } = fixture()
    const data = join(root, 'data')
    const source = join(data, 'devin', 'credentials.toml')
    mkdirSync(join(data, 'devin'), { recursive: true })
    const env = { HOME: hostHome, XDG_DATA_HOME: data }
    for (const text of [
      'api_server_url = "https://api.example.test"\n',
      'windsurf_api_key = ""\n',
      '[unrelated]\nwindsurf_api_key = "synthetic-key"\n',
      'windsurf_api_key = "unterminated\n'
    ]) {
      writeFileSync(source, text)
      expect(discoverSeededRuntimeCredentials('devin', env).paths).toEqual([])
    }
    const text = "# Stored login\nwindsurf_api_key = 'synthetic-key'\n"
    writeFileSync(source, text)
    expect(discoverSeededRuntimeCredentials('devin', { HOME: hostHome }).paths).toEqual([])
    expect(discoverSeededRuntimeCredentials('devin', env)).toEqual({ paths: [source], providers: ['devin'] })
    const home = prepareRuntimeHome('devin', scopeDir, env)
    expect(readFileSync(join(home, '.local', 'share', 'devin', 'credentials.toml'), 'utf8')).toBe(text)
  })

  it('uses Antigravity ACP file login under GEMINI_HOME instead of counting the separate CLI token', () => {
    const { hostHome, scopeDir } = fixture()
    const gemini = join(hostHome, 'custom-gemini')
    mkdirSync(join(gemini, 'antigravity-cli'), { recursive: true })
    mkdirSync(join(gemini, 'antigravity-acp'))
    writeFileSync(join(gemini, 'antigravity-cli', 'antigravity-oauth-token'), 'synthetic-cli-token')
    const env = { HOME: hostHome, GEMINI_HOME: '~/custom-gemini' }
    expect(discoverSeededRuntimeCredentials('antigravity-acp', env).paths).toEqual([])
    const source = join(gemini, 'antigravity-acp', 'acp_token.json')
    const text = '{"refresh_token":"synthetic-refresh"}'
    writeFileSync(source, text)
    expect(discoverSeededRuntimeCredentials('antigravity-acp', env)).toEqual({ paths: [source], providers: ['google'] })
    const home = prepareRuntimeHome('antigravity-acp', scopeDir, env)
    expect(readFileSync(join(home, '.gemini', 'antigravity-acp', 'acp_token.json'), 'utf8')).toBe(text)
    expect(runtimeHomeEnvironment('antigravity-acp', home, {}, env).GEMINI_HOME).toBe(join(home, '.gemini'))
  })

  it('uses Grok file and home overrides for both discovery and the private runtime', () => {
    const { root, hostHome, scopeDir } = fixture()
    const grokHome = join(root, 'grok-state')
    const source = join(root, 'grok-login.json')
    mkdirSync(grokHome)
    writeFileSync(join(grokHome, 'auth.json'), JSON.stringify({ default: { key: 'ignored-key', auth_mode: 'oidc' } }))
    writeFileSync(
      source,
      JSON.stringify({
        'https://issuer.example.test::public-client': {
          key: 'synthetic-key',
          auth_mode: 'oidc',
          oidc_issuer: 'https://issuer.example.test/',
          oidc_client_id: 'public-client'
        }
      })
    )
    const hostEnv = { HOME: hostHome, GROK_HOME: grokHome, GROK_AUTH_PATH: source }
    expect(discoverSeededRuntimeCredentials('grok-build', hostEnv)).toEqual({ paths: [source], providers: ['xai'] })
    const home = prepareRuntimeHome('grok-build', scopeDir, hostEnv)
    expect(readFileSync(join(home, '.grok', 'auth.json'), 'utf8')).toContain('synthetic-key')
    const env = runtimeHomeEnvironment('grok-build', home, {}, hostEnv)
    expect(env.GROK_HOME).toBe(join(home, '.grok'))
    expect(env.GROK_AUTH_PATH).toBe(join(home, '.grok', 'auth.json'))
  })

  it.each([
    {
      runtime: 'pi-acp',
      path: join('.pi', 'agent', 'auth.json'),
      override: 'PI_CODING_AGENT_DIR',
      credential: { anthropic: { type: 'api_key', key: 'ignored-key' } }
    },
    {
      runtime: 'grok-build',
      path: join('.grok', 'auth.json'),
      override: 'GROK_AUTH_PATH',
      credential: { 'xai::api_key': { key: 'ignored-key', auth_mode: 'api_key' } }
    },
    {
      runtime: 'github-copilot-cli',
      path: join('.copilot', 'config.json'),
      override: 'COPILOT_HOME',
      credential: { copilotTokens: { 'example-user': 'ignored-key' } }
    },
    {
      runtime: 'antigravity-acp',
      path: join('.gemini', 'antigravity-acp', 'acp_token.json'),
      override: 'GEMINI_HOME',
      credential: { refresh_token: 'ignored-key' }
    }
  ])(
    'keeps $runtime auth absent when its effective override has no login',
    ({ runtime, path, override, credential }) => {
      const { root, hostHome, scopeDir } = fixture()
      const source = join(hostHome, path)
      mkdirSync(join(source, '..'), { recursive: true })
      writeFileSync(source, JSON.stringify(credential))
      const env = { HOME: hostHome, [override]: join(root, 'empty-override') }
      expect(discoverSeededRuntimeCredentials(runtime, env)).toEqual({ paths: [], providers: [] })
      const home = prepareRuntimeHome(runtime, scopeDir, env)
      expect(existsSync(join(home, path))).toBe(false)
    }
  )

  it('discovers model credentials in both DSH layouts and ignores unrelated service keys', () => {
    const { hostHome, scopeDir } = fixture()
    const dsh = join(hostHome, '.dsh')
    mkdirSync(dsh)
    const source = join(dsh, '.credentials.yaml')
    writeFileSync(source, 'MCP_SERVER_TOKEN: synthetic-service-key\n')
    writeFileSync(join(dsh, '.env'), 'DEEPSEEK_BASE_URL=https://provider.example.test\n')
    expect(discoverSeededRuntimeCredentials('dsh-acp', { HOME: hostHome }).paths).toEqual([])
    writeFileSync(source, 'version: 1\nrecords:\n  llm-pi-ai/openai:\n    kind: api-key\n')
    expect(discoverSeededRuntimeCredentials('dsh-acp', { HOME: hostHome }).paths).toEqual([])
    for (const text of [
      'DEEPSEEK_API_KEY: synthetic-key\n',
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: synthetic-key\n'
    ]) {
      writeFileSync(source, text)
      expect(discoverSeededRuntimeCredentials('dsh-acp', { HOME: hostHome })).toEqual({
        paths: [source],
        providers: ['deepseek']
      })
    }
    const home = prepareRuntimeHome('dsh-acp', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.dsh', '.credentials.yaml'), 'utf8')).toContain('synthetic-key')
  })

  it.each([
    {
      runtime: 'grok-build',
      path: join('.grok', 'auth.json'),
      value: { unrelated: { key: 'synthetic', auth_mode: 'oidc' } }
    },
    {
      runtime: 'hermes-agent',
      path: join('.hermes', 'auth.json'),
      value: { providers: { spotify: { access_token: 'synthetic' } } }
    },
    {
      runtime: 'amp-acp',
      path: join('.local', 'share', 'amp', 'secrets.json'),
      value: { 'github-access-token@https://example.test': 'synthetic' }
    }
  ])('ignores unrelated records in the $runtime shared auth store', ({ runtime, path, value }) => {
    const { hostHome } = fixture()
    const source = join(hostHome, path)
    mkdirSync(join(source, '..'), { recursive: true })
    writeFileSync(source, JSON.stringify(value))
    expect(discoverSeededRuntimeCredentials(runtime, { HOME: hostHome })).toEqual({ paths: [], providers: [] })
  })

  it('seeds only Pi auth/settings from its nested agent directory', () => {
    const { hostHome, scopeDir } = fixture()
    const agentDir = join(hostHome, '.pi', 'agent')
    mkdirSync(join(agentDir, 'sessions'), { recursive: true })
    mkdirSync(join(agentDir, 'bin'))
    writeFileSync(join(agentDir, 'auth.json'), '{"provider":"host"}')
    writeFileSync(join(agentDir, 'settings.json'), '{"quietStartup":true}')
    writeFileSync(join(agentDir, 'sessions', 'old.jsonl'), 'do-not-copy')
    writeFileSync(join(agentDir, 'bin', 'fd'), 'do-not-copy')

    const home = prepareRuntimeHome('pi-acp', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.pi', 'agent', 'auth.json'), 'utf8')).toContain('host')
    expect(existsSync(join(home, '.pi', 'agent', 'settings.json'))).toBe(true)
    expect(existsSync(join(home, '.pi', 'agent', 'sessions'))).toBe(false)
    expect(existsSync(join(home, '.pi', 'agent', 'bin'))).toBe(false)

    const env = runtimeHomeEnvironment('pi-acp', home, {}, { HOME: hostHome })
    expect(env.PI_CODING_AGENT_DIR).toBe(join(home, '.pi', 'agent'))
  })

  it('seeds Qoder config + browser-login credentials without copying sessions', () => {
    const { hostHome, scopeDir } = fixture()
    const qoder = join(hostHome, '.qoder')
    mkdirSync(join(qoder, 'sessions'), { recursive: true })
    writeFileSync(join(qoder, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(qoder, '.keychain-salt'), 'salt-bytes')
    writeFileSync(join(qoder, 'qoder-cli-credentials.json'), '{"token":"host"}')
    writeFileSync(join(qoder, 'sessions', 'old.jsonl'), 'do-not-copy')

    const home = prepareRuntimeHome('qoder-cli', scopeDir, { HOME: hostHome })
    expect(existsSync(join(home, '.qoder', 'settings.json'))).toBe(true)
    expect(existsSync(join(home, '.qoder', '.keychain-salt'))).toBe(true)
    expect(readFileSync(join(home, '.qoder', 'qoder-cli-credentials.json'), 'utf8')).toContain('host')
    expect(existsSync(join(home, '.qoder', 'sessions'))).toBe(false)
  })

  it('strips host Qoder config-dir overrides so isolation cannot be bypassed', () => {
    const { hostHome, scopeDir } = fixture()
    const home = prepareRuntimeHome('qoder-cli', scopeDir, { HOME: hostHome })
    const env = runtimeHomeEnvironment(
      'qoder-cli',
      home,
      {},
      {
        HOME: hostHome,
        QODER_CONFIG_DIR: '/host/leak',
        QODER_CLI_HOME: '/host/leak',
        GEMINI_CLI_HOME: '/host/leak'
      }
    )
    expect(env.HOME).toBe(home)
    expect(env.QODER_CONFIG_DIR).toBe(join(home, '.qoder'))
    expect(env.QODER_CLI_HOME).toBeUndefined()
    expect(env.GEMINI_CLI_HOME).toBeUndefined()
  })

  it('seeds DeepSeek Harness credentials and pins $DSH_HOME into the private home', () => {
    const { hostHome, scopeDir } = fixture()
    const dsh = join(hostHome, '.dsh')
    mkdirSync(join(dsh, 'sessions'), { recursive: true })
    writeFileSync(join(dsh, '.credentials.yaml'), 'deepseek: host-key')
    writeFileSync(join(dsh, '.env'), 'DEEPSEEK_BASE_URL=https://host.example')
    writeFileSync(join(dsh, 'sessions', 'old.jsonl'), 'do-not-copy')

    const home = prepareRuntimeHome('dsh-acp', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.dsh', '.credentials.yaml'), 'utf8')).toContain('host-key')
    expect(existsSync(join(home, '.dsh', '.env'))).toBe(true)
    expect(existsSync(join(home, '.dsh', 'sessions'))).toBe(false)

    const env = runtimeHomeEnvironment('dsh-acp', home, {}, { HOME: hostHome, DSH_HOME: '/host/leak' })
    expect(env.DSH_HOME).toBe(join(home, '.dsh'))
  })

  it('seeds the OpenClaw gateway config and pins $OPENCLAW_STATE_DIR into the private home', () => {
    const { hostHome, scopeDir } = fixture()
    const openclaw = join(hostHome, '.openclaw')
    mkdirSync(join(openclaw, 'sessions'), { recursive: true })
    writeFileSync(join(openclaw, 'openclaw.json'), '{"gateway":{"url":"ws://127.0.0.1:18789","token":"host-token"}}')
    writeFileSync(join(openclaw, '.env'), 'OPENCLAW_GATEWAY_TOKEN=host-token')
    writeFileSync(join(openclaw, 'sessions', 'old.jsonl'), 'do-not-copy')

    const home = prepareRuntimeHome('openclaw', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf8')).toContain('18789')
    expect(existsSync(join(home, '.openclaw', '.env'))).toBe(true)
    expect(existsSync(join(home, '.openclaw', 'sessions'))).toBe(false)

    const env = runtimeHomeEnvironment(
      'openclaw',
      home,
      {},
      {
        HOME: hostHome,
        OPENCLAW_STATE_DIR: '/host/leak',
        OPENCLAW_HOME: '/host/leak-home',
        OPENCLAW_CONFIG_PATH: '/host/leak.json',
        OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:19000'
      }
    )
    expect(env.OPENCLAW_STATE_DIR).toBe(join(home, '.openclaw'))
    expect(env.OPENCLAW_HOME).toBeUndefined()
    expect(env.OPENCLAW_CONFIG_PATH).toBeUndefined()
    // Gateway connection overrides are credentials, not user state — inherited.
    expect(env.OPENCLAW_GATEWAY_URL).toBe('ws://127.0.0.1:19000')
  })

  it('seeds a relocated $OPENCLAW_CONFIG_PATH config ahead of the stale state-dir copy', () => {
    const { root, hostHome, scopeDir } = fixture()
    mkdirSync(join(hostHome, '.openclaw'), { recursive: true })
    writeFileSync(join(hostHome, '.openclaw', 'openclaw.json'), '{"gateway":{"url":"ws://stale.invalid"}}')
    const configPath = join(root, 'etc-openclaw.json')
    writeFileSync(configPath, '{"gateway":{"url":"ws://127.0.0.1:18789"}}')

    const home = prepareRuntimeHome('openclaw', scopeDir, { HOME: hostHome, OPENCLAW_CONFIG_PATH: configPath })
    expect(readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf8')).toContain('18789')
  })

  it('seeds Cline provider auth from its data directory without copying databases', () => {
    const { hostHome, scopeDir } = fixture()
    const clineDir = join(hostHome, '.cline')
    mkdirSync(join(clineDir, 'data', 'settings'), { recursive: true })
    mkdirSync(join(clineDir, 'data', 'db'))
    mkdirSync(join(clineDir, 'data', 'logs'))
    writeFileSync(join(clineDir, 'data', 'settings', 'providers.json'), '{"providers":{"host":{}}}')
    writeFileSync(join(clineDir, 'data', 'db', 'sessions.db'), 'do-not-copy')
    writeFileSync(join(clineDir, 'data', 'logs', 'cline.log'), 'do-not-copy')

    const home = prepareRuntimeHome('cline', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.cline', 'data', 'settings', 'providers.json'), 'utf8')).toContain('host')
    expect(existsSync(join(home, '.cline', 'data', 'db'))).toBe(false)
    expect(existsSync(join(home, '.cline', 'data', 'logs'))).toBe(false)

    const env = runtimeHomeEnvironment(
      'cline',
      home,
      {},
      {
        HOME: hostHome,
        CLINE_DATA_DIR: '/tmp/shared-cline-data',
        CLINE_PROVIDER_SETTINGS_PATH: '/tmp/shared-providers.json'
      }
    )
    expect(env.CLINE_DIR).toBe(join(home, '.cline'))
    expect(env.CLINE_DATA_DIR).toBe(join(home, '.cline', 'data'))
    expect(env.CLINE_PROVIDER_SETTINGS_PATH).toBeUndefined()
  })

  it('uses private HOME/XDG state and drops ambient tool state overrides', () => {
    const { hostHome, scopeDir } = fixture()
    const home = prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    const env = runtimeHomeEnvironment(
      'claude-acp',
      home,
      { NPM_CONFIG_REGISTRY: 'https://registry.example.test' },
      {
        HOME: hostHome,
        PATH: '/usr/bin',
        NPM_CONFIG_CACHE: '/tmp/shared-cache',
        CARGO_HOME: '/tmp/shared-cargo',
        RUSTUP_HOME: '/tmp/shared-rustup'
      }
    )

    expect(env.HOME).toBe(home)
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, '.claude'))
    expect(env.XDG_CACHE_HOME).toBe(join(home, '.cache'))
    expect(env.NPM_CONFIG_CACHE).toBeUndefined()
    expect(env.CARGO_HOME).toBeUndefined()
    expect(env.RUSTUP_HOME).toBeUndefined()
    expect(env.NPM_CONFIG_REGISTRY).toBe('https://registry.example.test')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('moves legacy per-agent runtime state under the private HOME', () => {
    const { hostHome, scopeDir } = fixture()
    const legacyMemory = join(scopeDir, '.claude', 'projects', 'workspace', 'memory')
    mkdirSync(legacyMemory, { recursive: true })
    writeFileSync(join(legacyMemory, 'MEMORY.md'), 'legacy memory')

    const home = prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })
    expect(readFileSync(join(home, '.claude', 'projects', 'workspace', 'memory', 'MEMORY.md'), 'utf8')).toBe(
      'legacy memory'
    )
    expect(existsSync(join(scopeDir, '.claude'))).toBe(false)
  })

  it('refuses to seed through a symlink created inside the private HOME', () => {
    const { root, hostHome, scopeDir } = fixture()
    writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"token":"host"}')
    const home = join(scopeDir, 'home')
    const outside = join(root, 'outside')
    mkdirSync(home)
    mkdirSync(outside)
    symlinkSync(outside, join(home, '.claude'))

    expect(() => prepareRuntimeHome('claude-acp', scopeDir, { HOME: hostHome })).toThrow(/symlink/)
  })

  it('seeds only reviewed curated config files and maps every private state root', () => {
    const { hostHome, scopeDir } = fixture()
    const hermes = join(hostHome, '.hermes')
    const interpreter = join(hostHome, '.openinterpreter')
    const kiro = join(hostHome, '.kiro')
    const zeroclaw = join(hostHome, '.zeroclaw')
    mkdirSync(join(hermes, 'memories'), { recursive: true })
    mkdirSync(join(interpreter, 'sessions'), { recursive: true })
    mkdirSync(join(kiro, 'settings'), { recursive: true })
    mkdirSync(join(kiro, 'sessions'), { recursive: true })
    mkdirSync(join(zeroclaw, 'data'), { recursive: true })
    writeFileSync(join(hermes, 'config.yaml'), 'model: test')
    writeFileSync(join(hermes, 'memories', 'private.md'), 'do-not-copy')
    writeFileSync(join(interpreter, 'config.toml'), 'model = "test"')
    writeFileSync(join(interpreter, 'sessions', 'old.json'), 'do-not-copy')
    writeFileSync(join(kiro, 'settings', 'cli.json'), '{}')
    writeFileSync(join(kiro, 'sessions', 'old.json'), 'do-not-copy')
    writeFileSync(join(zeroclaw, 'config.toml'), 'provider = "test"')
    writeFileSync(join(zeroclaw, 'data', 'memory.db'), 'do-not-copy')

    const hermesHome = prepareRuntimeHome('hermes-agent', join(scopeDir, 'hermes'), { HOME: hostHome })
    const interpreterHome = prepareRuntimeHome('open-interpreter', join(scopeDir, 'interpreter'), { HOME: hostHome })
    const kiroHome = prepareRuntimeHome('kiro-cli', join(scopeDir, 'kiro'), { HOME: hostHome })
    const zeroclawHome = prepareRuntimeHome('zeroclaw', join(scopeDir, 'zeroclaw'), { HOME: hostHome })

    expect(existsSync(join(hermesHome, '.hermes', 'config.yaml'))).toBe(true)
    expect(existsSync(join(hermesHome, '.hermes', 'memories'))).toBe(false)
    expect(existsSync(join(interpreterHome, '.openinterpreter', 'config.toml'))).toBe(true)
    expect(existsSync(join(interpreterHome, '.openinterpreter', 'sessions'))).toBe(false)
    expect(existsSync(join(kiroHome, '.kiro', 'settings', 'cli.json'))).toBe(true)
    expect(existsSync(join(kiroHome, '.kiro', 'sessions'))).toBe(false)
    expect(existsSync(join(zeroclawHome, '.zeroclaw', 'config.toml'))).toBe(true)
    expect(existsSync(join(zeroclawHome, '.zeroclaw', 'data'))).toBe(false)

    expect(runtimeHomeEnvironment('hermes-agent', hermesHome).HERMES_HOME).toBe(join(hermesHome, '.hermes'))
    expect(runtimeHomeEnvironment('open-interpreter', interpreterHome).INTERPRETER_HOME).toBe(
      join(interpreterHome, '.openinterpreter')
    )
    expect(runtimeHomeEnvironment('open-interpreter', interpreterHome).CODEX_HOME).toBe(join(interpreterHome, '.codex'))
    expect(runtimeHomeEnvironment('kiro-cli', kiroHome).KIRO_HOME).toBe(join(kiroHome, '.kiro'))
    expect(runtimeHomeEnvironment('zeroclaw', zeroclawHome).ZEROCLAW_CONFIG_DIR).toBe(join(zeroclawHome, '.zeroclaw'))
    expect(runtimeHomeEnvironment('zeroclaw', zeroclawHome).ZEROCLAW_DATA_DIR).toBe(
      join(zeroclawHome, '.zeroclaw', 'data')
    )
  })

  it('seeds Maki config without copying XDG data/state memory', () => {
    const { root, hostHome, scopeDir } = fixture()
    const config = join(root, 'config')
    const data = join(root, 'data')
    const state = join(root, 'state')
    mkdirSync(join(config, 'maki'), { recursive: true })
    mkdirSync(join(data, 'maki'), { recursive: true })
    mkdirSync(join(state, 'maki'), { recursive: true })
    writeFileSync(join(config, 'maki', 'init.lua'), 'maki.setup({})')
    writeFileSync(join(config, 'maki', 'permissions.toml'), 'default = "ask"')
    writeFileSync(join(data, 'maki', 'memory.db'), 'do-not-copy')
    writeFileSync(join(state, 'maki', 'session.db'), 'do-not-copy')

    const home = prepareRuntimeHome('maki', scopeDir, {
      HOME: hostHome,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state
    })

    expect(existsSync(join(home, '.config', 'maki', 'init.lua'))).toBe(true)
    expect(existsSync(join(home, '.config', 'maki', 'permissions.toml'))).toBe(true)
    expect(existsSync(join(home, '.local', 'share', 'maki', 'memory.db'))).toBe(false)
    expect(existsSync(join(home, '.local', 'state', 'maki', 'session.db'))).toBe(false)
  })

  it('extracts only OMP credential tables from a WAL database above the generic seed limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-omp-db-'))
    const sourcePath = join(root, 'agent.db')
    const destinationPath = join(root, 'private', 'agent.db')
    const source = new DatabaseSync(sourcePath)
    source.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        data TEXT NOT NULL,
        disabled_cause TEXT,
        identity_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE padding (payload BLOB NOT NULL);
      INSERT INTO auth_schema_version VALUES (1, 3);
      INSERT INTO settings VALUES ('theme', 'dark');
      INSERT INTO padding VALUES (zeroblob(3145728));
      PRAGMA wal_checkpoint(TRUNCATE);
      INSERT INTO auth_credentials(provider, credential_type, data, created_at, updated_at)
        VALUES ('anthropic', 'api_key', '{"key":"secret"}', 1, 1);
    `)
    expect(statSync(sourcePath).size).toBeGreaterThan(2 * 1024 * 1024)
    const sourceDigest = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')

    extractOmpCredentials(sourcePath, destinationPath)

    expect(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')).toBe(sourceDigest)
    source.close()
    const destination = new DatabaseSync(destinationPath, { readOnly: true })
    const tables = destination
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String(row.name))
    expect(tables).toEqual(['auth_credentials', 'auth_schema_version'])
    expect(destination.prepare('SELECT provider, data FROM auth_credentials').get()).toEqual({
      provider: 'anthropic',
      data: '{"key":"secret"}'
    })
    destination.close()
  })

  it('rejects an oversized OMP credential row', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-omp-large-'))
    const sourcePath = join(root, 'agent.db')
    const source = new DatabaseSync(sourcePath)
    source.exec(`
      CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, data TEXT);
      INSERT INTO auth_schema_version VALUES (1, 1);
    `)
    source.prepare('INSERT INTO auth_credentials VALUES (?, ?, ?)').run(1, 'test', 'x'.repeat(300 * 1024))
    source.close()

    expect(() => extractOmpCredentials(sourcePath, join(root, 'private.db'))).toThrow(/credential row/i)
  })

  it('refuses an OMP credential destination symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-omp-symlink-'))
    const sourcePath = join(root, 'agent.db')
    const outsidePath = join(root, 'outside.db')
    const destinationPath = join(root, 'private.db')
    const source = new DatabaseSync(sourcePath)
    source.exec(`
      CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, data TEXT);
      INSERT INTO auth_schema_version VALUES (1, 1);
    `)
    source.close()
    writeFileSync(outsidePath, 'outside')
    symlinkSync(outsidePath, destinationPath)

    expect(() => extractOmpCredentials(sourcePath, destinationPath)).toThrow(/symlink/i)
    expect(readFileSync(outsidePath, 'utf8')).toBe('outside')
  })
})

describe('hostPackageCacheEnv', () => {
  it('pins npx at the host npm cache so a fresh probe HOME does not rebuild the tree', () => {
    expect(hostPackageCacheEnv('npx', { HOME: '/host' })).toEqual({ npm_config_cache: join('/host', '.npm') })
  })

  it('honors an ambient npm cache override', () => {
    expect(hostPackageCacheEnv('npx', { HOME: '/host', NPM_CONFIG_CACHE: '/shared/npm' })).toEqual({
      npm_config_cache: '/shared/npm'
    })
  })

  it('pins uvx at the host uv cache, honoring XDG_CACHE_HOME', () => {
    expect(hostPackageCacheEnv('uvx', { HOME: '/host' })).toEqual({ UV_CACHE_DIR: join('/host', '.cache', 'uv') })
    expect(hostPackageCacheEnv('uvx', { HOME: '/host', XDG_CACHE_HOME: '/xdg' })).toEqual({
      UV_CACHE_DIR: join('/xdg', 'uv')
    })
  })

  it('pins nothing for a real binary distribution', () => {
    expect(hostPackageCacheEnv('qodercli', { HOME: '/host' })).toEqual({})
    expect(hostPackageCacheEnv(undefined, { HOME: '/host' })).toEqual({})
  })
})
