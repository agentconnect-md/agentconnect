import { afterEach, describe, expect, it } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'

const roots: string[] = []
const key = 'fixture-native-api-key'
function write(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}

function fixture(runtimeId: 'claude-acp' | 'codex-acp') {
  const root = mkdtempSync(join(tmpdir(), 'ac-native-api-'))
  roots.push(root)
  const hostHome = join(root, 'host')
  const scopeDir = join(root, 'agent')
  const cwd = join(scopeDir, 'workspace')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(hostHome)
  return {
    root,
    hostHome,
    runtimeId,
    runtime: { command: runtimeId === 'claude-acp' ? 'claude-agent-acp' : 'codex-acp', args: [], env: [] },
    scopeDir,
    cwd,
    mounts: [],
    stateSourceEnv: { HOME: hostHome }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('microsandbox native file API credentials', () => {
  it.each(['default', 'relocated', 'legacy'])(
    'protects Claude %s login without changing native auth precedence',
    (layout) => {
      const opts = fixture('claude-acp')
      const configDir = join(opts.hostHome, layout === 'default' ? '.claude' : 'configured-claude')
      const source =
        layout === 'default'
          ? join(opts.hostHome, '.claude.json')
          : join(configDir, layout === 'legacy' ? '.config.json' : '.claude.json')
      const stateSourceEnv = {
        ...opts.stateSourceEnv,
        CODEX_CA_CERTIFICATE: '/tmp/codex-only-ca.pem',
        ...(layout === 'default' ? {} : { CLAUDE_CONFIG_DIR: configDir })
      }
      const host = {
        primaryApiKey: key,
        additionalModelOptionsCache: { model: 'fixture-model' },
        projects: { private: {} }
      }
      write(source, host)
      const launchOpts = { ...opts, stateSourceEnv }
      const launch = prepareMicrosandboxLaunch(launchOpts)
      const secret = launch.microsandbox.secrets![0]!
      expect(secret.host).toEqual(['api.anthropic.com'])
      expect(secret.readValue()).toBe(key)
      expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(JSON.stringify(launch)).not.toContain(key)
      expect(launch.microsandbox.mounts.some(({ source }) => source === configDir)).toBe(false)
      const path = join(launch.runtimeHome!, '.claude', layout === 'legacy' ? '.config.json' : '.claude.json')
      const projected = JSON.parse(readFileSync(path, 'utf8'))
      expect(projected).toEqual({
        primaryApiKey: secret.placeholder,
        additionalModelOptionsCache: host.additionalModelOptionsCache
      })
      expect(launch.toolSandbox!.protectedCredentialRoots).toContain(join(launch.runtimeHome!, '.claude'))
      projected.projects = { workspace: { approved: true } }
      write(path, projected)
      write(source, { ...host, primaryApiKey: 'fixture-rotated-key' })
      const resumed = prepareMicrosandboxLaunch(launchOpts)
      expect(resumed.microsandbox.secrets![0]!.readValue()).toBe('fixture-rotated-key')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(projected)
      expect(JSON.parse(readFileSync(source, 'utf8')).primaryApiKey).toBe('fixture-rotated-key')
      expect(() => prepareMicrosandboxLaunch({ ...launchOpts, trustedRuntimeReadRoots: [source] })).toThrow(
        'protected host credential'
      )
    }
  )

  it('keeps Claude OAuth shared while projecting a separate saved API key', () => {
    const opts = fixture('claude-acp')
    const credentialDir = join(opts.hostHome, '.claude')
    const oauth = { claudeAiOauth: { accessToken: 'fixture-oauth', refreshToken: 'fixture-refresh', expiresAt: 1 } }
    write(join(credentialDir, '.credentials.json'), oauth)
    write(join(opts.hostHome, '.claude.json'), { primaryApiKey: key })
    const launch = prepareMicrosandboxLaunch(opts)
    expect(launch.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(credentialDir)
    expect(launch.microsandbox.mounts).toContainEqual({
      source: credentialDir,
      target: credentialDir,
      mode: 'writable'
    })
    expect(JSON.parse(readFileSync(join(credentialDir, '.credentials.json'), 'utf8'))).toEqual(oauth)
    const source = join(credentialDir, '.config.json')
    write(source, { primaryApiKey: key })
    expect(() => prepareMicrosandboxLaunch(opts)).toThrow('protected host credential source')
  })

  it('replaces Codex auth mounts with private placeholders and preserves config and key rotation', () => {
    const opts = fixture('codex-acp')
    const auth = join(opts.hostHome, '.codex', 'auth.json')
    const config = join(opts.hostHome, '.codex', 'config.toml')
    write(auth, { auth_mode: 'apikey', OPENAI_API_KEY: key, tokens: null })
    write(
      config,
      `model = "fixture-model"\nopenai_base_url = "https://gateway.example.test/v1"\n[model_providers.other.http_headers]\nx-api-key = "${key}"\n`
    )
    const launch = prepareMicrosandboxLaunch(opts)
    const secret = launch.microsandbox.secrets![0]!
    expect(secret.host).toEqual(['gateway.example.test'])
    expect(launch.env.OPENAI_API_KEY).toBeUndefined()
    expect(launch.env.CODEX_API_KEY).toBeUndefined()
    expect(JSON.stringify(launch)).not.toContain(key)
    expect(launch.microsandbox.mounts.some(({ source }) => source === auth)).toBe(false)
    const path = join(launch.runtimeHome!, '.codex', 'auth.json')
    expect(lstatSync(path).isSymbolicLink()).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      auth_mode: 'apikey',
      OPENAI_API_KEY: secret.placeholder,
      tokens: null
    })
    expect(readFileSync(join(launch.runtimeHome!, '.codex', 'config.toml'), 'utf8')).not.toContain(key)
    expect(launch.toolSandbox!.protectedCredentialRoots).toContain(join(launch.runtimeHome!, '.codex'))
    write(auth, { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-rotated-key' })
    expect(prepareMicrosandboxLaunch(opts).microsandbox.secrets![0]!.readValue()).toBe('fixture-rotated-key')
    expect(JSON.parse(readFileSync(path, 'utf8')).OPENAI_API_KEY).toBe(secret.placeholder)
    expect(() =>
      prepareMicrosandboxLaunch({ ...opts, mounts: [{ source: auth, target: '/tmp/auth-alias', mode: 'readonly' }] })
    ).toThrow('protected host')
    write(auth, { auth_mode: 'chatgpt', OPENAI_API_KEY: key, tokens: { access_token: 'fixture-oauth' } })
    expect(() => prepareMicrosandboxLaunch(opts)).toThrow('combined API key and non-API authentication')
  })

  it('resolves Codex file logins and provider profiles without treating OPENAI_BASE_URL as routing', () => {
    const opts = fixture('codex-acp')
    const configDir = join(opts.hostHome, 'configured-codex')
    const auth = join(configDir, 'auth.json')
    const actual = join(opts.hostHome, 'managed-auth.json')
    write(actual, { OPENAI_API_KEY: key })
    mkdirSync(configDir)
    symlinkSync(actual, auth)
    write(
      join(configDir, 'config.toml'),
      'profile="fixture"\n[profiles.fixture]\nmodel_provider="custom"\n[model_providers.custom]\nbase_url="https://custom.example.test/v1"\nrequires_openai_auth=true\n'
    )
    const launchOpts = {
      ...opts,
      stateSourceEnv: { ...opts.stateSourceEnv, CODEX_HOME: configDir, OPENAI_BASE_URL: 'https://unused.example.test' }
    }
    const launch = prepareMicrosandboxLaunch(launchOpts)
    expect(launch.microsandbox.secrets![0]!.host).toEqual(['custom.example.test'])
    expect(JSON.parse(readFileSync(join(launch.runtimeHome!, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY).toMatch(
      /^msb-secret-/
    )
    const override = prepareMicrosandboxLaunch({
      ...launchOpts,
      explicitEnv: {
        CODEX_CONFIG: JSON.stringify({ model_provider: 'openai', openai_base_url: 'https://override.example.test/v1' })
      }
    })
    expect(override.microsandbox.secrets![0]!.host).toEqual(['override.example.test'])
    expect(() =>
      prepareMicrosandboxLaunch({ ...launchOpts, explicitEnv: { CODEX_CA_CERTIFICATE: '/tmp/custom-ca.pem' } })
    ).toThrow('custom TLS trust')
  })

  it.each(['claude-acp', 'codex-acp'] as const)(
    'withholds %s API keys from unsupported HTTP endpoints',
    (runtimeId) => {
      const opts = fixture(runtimeId)
      const claude = runtimeId === 'claude-acp'
      const source = join(opts.hostHome, claude ? '.claude.json' : '.codex/auth.json')
      write(source, claude ? { primaryApiKey: key } : { OPENAI_API_KEY: key })
      const base = 'http://localhost:8080/v1'
      const launch = prepareMicrosandboxLaunch({
        ...opts,
        explicitEnv: claude ? { ANTHROPIC_BASE_URL: base } : { CODEX_CONFIG: JSON.stringify({ openai_base_url: base }) }
      })
      expect(launch.microsandbox.secrets).toEqual([])
      const text = readFileSync(join(launch.runtimeHome!, claude ? '.claude/.claude.json' : '.codex/auth.json'), 'utf8')
      expect(text).not.toContain(key)
      expect(text).toContain('msb-secret-')
      expect(launch.env.NODE_EXTRA_CA_CERTS).toBeUndefined()
    }
  )
})
