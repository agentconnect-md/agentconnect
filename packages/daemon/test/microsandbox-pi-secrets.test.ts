import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'
import { prepareMicrosandboxCredentials } from '../src/microsandbox/secrets.js'
import { discoverSeededRuntimeCredentials } from '../src/runtimes/runtime-seeded-credentials.js'
import { prepareRuntimeHome } from '../src/runtimes/runtime-home.js'

const roots: string[] = []
const key = 'fixture-pi-api-key'
const oauth = { type: 'oauth', access: 'fixture-oauth', refresh: 'fixture-refresh', expires: 1 }
function write(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}
function fixture(relocated = false) {
  const root = mkdtempSync(join(tmpdir(), 'ac-pi-api-'))
  roots.push(root)
  const hostHome = join(root, 'host')
  const source = join(hostHome, relocated ? 'configured-pi' : '.pi/agent')
  const scopeDir = join(root, 'agent')
  const cwd = join(scopeDir, 'workspace')
  mkdirSync(cwd, { recursive: true })
  return {
    root,
    source,
    runtimeId: 'pi-acp',
    runtime: { command: 'pi-acp', args: [], env: [] },
    scopeDir,
    cwd,
    mounts: [],
    stateSourceEnv: { HOME: hostHome, ...(relocated ? { PI_CODING_AGENT_DIR: source } : {}) }
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('microsandbox pi API credentials', () => {
  it.each([false, true])('protects file logins and preserves refreshed OAuth, relocated=%s', (relocated) => {
    const opts = fixture(relocated)
    const source = join(opts.source, 'auth.json')
    write(source, { deepseek: { type: 'api_key', key }, 'github-copilot': oauth })
    write(join(opts.source, 'settings.json'), { defaultProvider: 'deepseek', extra: key })
    const launch = prepareMicrosandboxLaunch(opts)
    const secret = launch.microsandbox.secrets![0]!
    expect(secret.host).toEqual(['api.deepseek.com'])
    expect(secret.readValue()).toBe(key)
    expect(launch.env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(JSON.stringify(launch)).not.toContain(key)
    const path = join(launch.env.PI_CODING_AGENT_DIR!, 'auth.json')
    const auth = JSON.parse(readFileSync(path, 'utf8'))
    expect(auth).toEqual({ deepseek: { type: 'api_key', key: secret.placeholder }, 'github-copilot': oauth })
    expect(readFileSync(join(launch.env.PI_CODING_AGENT_DIR!, 'settings.json'), 'utf8')).not.toContain(key)
    auth['github-copilot'].access = 'fixture-refreshed'
    auth.local = { type: 'api_key', key: 'fixture-guest-key' }
    write(path, auth)
    write(source, { deepseek: { type: 'api_key', key: 'fixture-rotated-key' }, 'github-copilot': oauth })
    const resumed = prepareMicrosandboxLaunch(opts)
    expect(resumed.microsandbox.secrets![0]!.readValue()).toBe('fixture-rotated-key')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(auth)
    expect(JSON.parse(readFileSync(source, 'utf8'))['github-copilot']).toEqual(oauth)
    expect(() => prepareMicrosandboxLaunch({ ...opts, trustedRuntimeReadRoots: [opts.source] })).toThrow(
      'protected host credential'
    )
  })

  it('uses host JSONC model routes and deduplicates shared keys across auth and models', () => {
    const opts = fixture()
    write(join(opts.source, 'auth.json'), { openai: { type: 'api_key', key }, deepseek: { type: 'api_key', key } })
    write(
      join(opts.source, 'models.json'),
      `\uFEFF{
        // Host-authorized model endpoints.
        "providers": {
          "openai": {"baseUrl":"https://gateway.example.test/v1","headers":{"x-api-key":"${key}"}},
          "custom": {"apiKey":"${key}","baseUrl":"https://custom.example.test/v1","api":"openai-completions",
            "models":[{"id":"fixture-model","baseUrl":"https://model.example.test/v1"}],},
        },
      }`
    )
    const discovery = discoverSeededRuntimeCredentials('pi-acp', opts.stateSourceEnv)
    expect(discovery.providers.sort()).toEqual(['custom', 'deepseek', 'openai'])
    const launch = prepareMicrosandboxLaunch(opts)
    expect(launch.microsandbox.secrets).toHaveLength(1)
    const secret = launch.microsandbox.secrets![0]!
    expect(secret.host).toEqual([
      'api.deepseek.com',
      'custom.example.test',
      'gateway.example.test',
      'model.example.test'
    ])
    const path = join(launch.env.PI_CODING_AGENT_DIR!, 'models.json')
    const models = JSON.parse(readFileSync(path, 'utf8'))
    expect(models.providers.custom.apiKey).toBe(secret.placeholder)
    expect(models.providers.openai.headers['x-api-key']).toBe(secret.placeholder)
    models.providers.openai.baseUrl = 'https://guest-chosen.example.test'
    write(path, models)
    const resumed = prepareMicrosandboxLaunch(opts)
    expect(resumed.microsandbox.secrets![0]!.host).toEqual(secret.host)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(models)
  })

  it('discovers and protects a models-only API login while keeping shared native HOME seeding', () => {
    const opts = fixture(true)
    write(join(opts.source, 'models.json'), {
      providers: { custom: { apiKey: key, baseUrl: 'https://api.example.test', api: 'openai-completions', models: [] } }
    })
    expect(discoverSeededRuntimeCredentials('pi-acp', opts.stateSourceEnv).providers).toEqual(['custom'])
    const launch = prepareMicrosandboxLaunch(opts)
    expect(launch.microsandbox.secrets![0]!.host).toEqual(['api.example.test'])
    expect(readFileSync(join(launch.env.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8')).not.toContain(key)
    const nativeHome = prepareRuntimeHome('pi-acp', join(opts.root, 'native'), opts.stateSourceEnv)
    expect(readFileSync(join(nativeHome, '.pi/agent/models.json'), 'utf8')).toContain(key)
  })

  it('withholds unsupported credentials without executing helpers or leaking scoped secrets', () => {
    const opts = fixture()
    const marker = join(opts.root, 'helper-executed')
    write(join(opts.source, 'auth.json'), {
      unknown: { type: 'api_key', key: 'fixture-unknown-key' },
      helper: { type: 'api_key', key: `!touch ${marker}` },
      structured: { type: 'api_key', key: '$KEY', env: { KEY: 'fixture-scoped-key', OTHER: 'fixture-other-key' } },
      deepseek: { type: 'api_key', key },
      'github-copilot': oauth
    })
    write(join(opts.source, 'models.json'), {
      providers: { unknown: { baseUrl: 'http://localhost:8080' }, helper: { baseUrl: 'https://api.example.test' } }
    })
    const launch = prepareMicrosandboxLaunch(opts)
    expect(launch.microsandbox.secrets).toHaveLength(1)
    expect(launch.microsandbox.secrets![0]!.readValue()).toBe(key)
    const auth = JSON.parse(readFileSync(join(launch.env.PI_CODING_AGENT_DIR!, 'auth.json'), 'utf8'))
    for (const provider of ['unknown', 'helper', 'structured']) {
      expect(auth[provider]).toEqual({ type: 'api_key', key: expect.stringMatching(/^msb-secret-/) })
    }
    expect(auth['github-copilot']).toEqual(oauth)
    expect(JSON.stringify(launch)).not.toContain('fixture-scoped-key')
    expect(existsSync(marker)).toBe(false)
  })

  it('leaves pure OAuth on the native path and skips symlinked host files', () => {
    const opts = fixture()
    write(join(opts.source, 'auth.json'), { 'github-copilot': oauth })
    expect(prepareMicrosandboxCredentials('pi-acp', opts.runtime, opts.stateSourceEnv)).toBeUndefined()
    const launch = prepareMicrosandboxLaunch(opts)
    expect(launch.microsandbox.secrets).toBeUndefined()
    expect(JSON.parse(readFileSync(join(launch.env.PI_CODING_AGENT_DIR!, 'auth.json'), 'utf8'))).toEqual({
      'github-copilot': oauth
    })
    const other = fixture()
    const actual = join(other.root, 'managed.json')
    write(actual, { deepseek: { type: 'api_key', key } })
    mkdirSync(other.source, { recursive: true })
    symlinkSync(actual, join(other.source, 'auth.json'))
    expect(prepareMicrosandboxCredentials('pi-acp', other.runtime, other.stateSourceEnv)).toBeUndefined()
    expect(prepareMicrosandboxCredentials('custom-pi', other.runtime, opts.stateSourceEnv)).toBeUndefined()
  })
})
