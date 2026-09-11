import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'
import { prepareMicrosandboxCredentials } from '../src/microsandbox/secrets.js'
import { discoverSeededRuntimeCredentials } from '../src/runtimes/runtime-seeded-credentials.js'
import { prepareRuntimeHome, runtimeHomeEnvironment } from '../src/runtimes/runtime-home.js'

const roots: string[] = []
const key = 'fixture-qwen-api-key'
const oauth = { access_token: 'fixture-oauth', refresh_token: 'fixture-refresh', expiry_date: 1 }
function write(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}
function fixture(relocated = false) {
  const root = mkdtempSync(join(tmpdir(), 'ac-qwen-api-'))
  roots.push(root)
  const hostHome = join(root, 'host')
  const source = join(hostHome, relocated ? 'configured-qwen' : '.qwen')
  const scopeDir = join(root, 'agent'),
    cwd = join(scopeDir, 'workspace')
  mkdirSync(cwd, { recursive: true })
  return {
    root,
    source,
    scopeDir,
    cwd,
    mounts: [],
    runtimeId: 'qwen-code',
    runtime: { command: 'qwen', args: ['--acp'], env: [] },
    stateSourceEnv: {
      HOME: hostHome,
      ...(relocated ? { QWEN_HOME: '~/configured-qwen', QWEN_RUNTIME_DIR: '/host/runtime' } : {})
    }
  }
}
function config(value = key) {
  return {
    env: { MODEL_KEY: value },
    security: { auth: { selectedType: 'openai' } },
    modelProviders: { openai: [{ id: 'fixture-model', envKey: 'MODEL_KEY', baseUrl: 'https://api.example.test/v1' }] },
    model: { name: 'fixture-model' },
    extra: { Authorization: `Bearer ${value}` }
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('uses the shared file references for discovery and native HOME seeding, including default keys', () => {
  const opts = fixture(true),
    path = join(opts.source, 'settings.json')
  write(path, {
    modelProviders: { openai: [{ id: 'fixture-model' }], custom: [{ id: 'fixture-model' }] },
    providerProtocol: { custom: 'anthropic' },
    env: { OPENAI_API_KEY: key, ANTHROPIC_API_KEY: key }
  })
  expect(discoverSeededRuntimeCredentials(opts.runtimeId, opts.stateSourceEnv)).toEqual({
    paths: [path],
    providers: ['openai', 'custom']
  })
  const home = prepareRuntimeHome(opts.runtimeId, opts.scopeDir, opts.stateSourceEnv)
  expect(readFileSync(join(home, '.qwen/settings.json'), 'utf8')).toContain(key)
  const env = runtimeHomeEnvironment(opts.runtimeId, home, {}, opts.stateSourceEnv)
  expect(env.QWEN_HOME).toBe(join(home, '.qwen'))
  expect(env.QWEN_RUNTIME_DIR).toBe(env.QWEN_HOME)
})

describe.skipIf(process.platform !== 'linux')('microsandbox Qwen API credentials', () => {
  it.each([false, true])(
    'projects file env credentials and preserves OAuth and guest edits, relocated=%s',
    (relocated) => {
      const opts = fixture(relocated),
        source = join(opts.source, 'settings.json')
      write(source, '// Native JSONC settings\n' + JSON.stringify(config()))
      write(join(opts.source, 'settings.json.backup'), config())
      write(join(opts.source, 'oauth_creds.json'), oauth)
      write(join(opts.source, 'mcp-oauth-tokens.json'), [oauth])
      const launch = prepareMicrosandboxLaunch(opts),
        secret = launch.microsandbox.secrets![0]!
      expect(secret.host).toEqual(['api.example.test'])
      expect(secret.readValue()).toBe(key)
      expect(JSON.stringify(launch)).not.toContain(key)
      expect(launch.env.MODEL_KEY).toBeUndefined()
      const guest = launch.env.QWEN_HOME!,
        settings = join(guest, 'settings.json')
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(config(secret.placeholder))
      expect(existsSync(join(guest, 'settings.json.backup'))).toBe(false)
      expect(JSON.parse(readFileSync(join(guest, 'mcp-oauth-tokens.json'), 'utf8'))).toEqual([oauth])
      write(join(guest, 'oauth_creds.json'), { ...oauth, access_token: 'fixture-refreshed' })
      const edited = config(secret.placeholder)
      edited.modelProviders.openai[0]!.baseUrl = 'https://guest-chosen.example.test'
      write(settings, edited)
      write(source, config('fixture-rotated-key'))
      const resumed = prepareMicrosandboxLaunch(opts)
      expect(resumed.microsandbox.secrets![0]!.readValue()).toBe('fixture-rotated-key')
      expect(resumed.microsandbox.secrets![0]!.host).toEqual(secret.host)
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(edited)
      expect(readFileSync(join(guest, 'oauth_creds.json'), 'utf8')).toContain('fixture-refreshed')
      expect(readFileSync(join(opts.source, 'oauth_creds.json'), 'utf8')).not.toContain('fixture-refreshed')
      expect(() =>
        prepareMicrosandboxLaunch({ ...opts, mounts: [{ source, target: '/raw-config', mode: 'readonly' }] })
      ).toThrow(/protected host/)
    }
  )

  it('protects legacy credentials and shared keys across providers, including independent rotation', () => {
    const opts = fixture(),
      source = join(opts.source, 'settings.json')
    const settings = {
      env: { FIRST_KEY: key, SECOND_KEY: key },
      modelProviders: {
        openai: [{ id: 'one', envKey: 'FIRST_KEY', baseUrl: 'https://one.example.test' }],
        custom: [
          { id: 'two', envKey: 'SECOND_KEY', baseUrl: 'https://two.example.test' },
          { id: 'legacy', baseUrl: 'https://custom-legacy.example.test' }
        ]
      },
      providerProtocol: { custom: 'openai' },
      security: { auth: { selectedType: 'openai', apiKey: key, baseUrl: 'https://legacy.example.test' } }
    }
    write(source, settings)
    const launch = prepareMicrosandboxLaunch(opts)
    expect(launch.microsandbox.secrets).toHaveLength(1)
    expect(launch.microsandbox.secrets![0]!.host).toEqual([
      'custom-legacy.example.test',
      'legacy.example.test',
      'one.example.test',
      'two.example.test'
    ])
    settings.env.FIRST_KEY = 'fixture-rotated-key'
    write(source, settings)
    const resumed = prepareMicrosandboxLaunch(opts)
    const stored = JSON.parse(readFileSync(join(resumed.env.QWEN_HOME!, 'settings.json'), 'utf8'))
    expect(stored.env.FIRST_KEY).toBe(
      resumed.microsandbox.secrets!.find((secret) => secret.readValue() === settings.env.FIRST_KEY)!.placeholder
    )
    expect(stored.env.SECOND_KEY).toBe(stored.security.auth.apiKey)
    expect(stored.env.FIRST_KEY).not.toBe(stored.env.SECOND_KEY)
  })

  it('hides unsupported keys, keeps missing credentials undiscovered, and sanitizes unused retained env fields', () => {
    const opts = fixture(),
      source = join(opts.source, 'settings.json')
    const settings = {
      env: { BAD_URL: 'fixture-bad', NO_URL: 'fixture-no-url', TEMPLATE: '${PRIVATE_KEY}', UNKNOWN: 'fixture-unknown' },
      modelProviders: {
        openai: [
          { id: 'one', envKey: 'BAD_URL', baseUrl: 'http://api.example.test' },
          { id: 'two', envKey: 'NO_URL' },
          { id: 'three', envKey: 'TEMPLATE', baseUrl: 'https://api.example.test' },
          { id: 'missing', envKey: 'MISSING' }
        ],
        unknown: [{ id: 'four', envKey: 'UNKNOWN', baseUrl: 'https://unknown.example.test' }]
      }
    }
    write(source, settings)
    expect(discoverSeededRuntimeCredentials(opts.runtimeId, opts.stateSourceEnv).providers).toEqual([
      'openai',
      'unknown'
    ])
    const launch = prepareMicrosandboxLaunch(opts)
    expect(launch.microsandbox.secrets).toEqual([])
    const path = join(launch.env.QWEN_HOME!, 'settings.json')
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.values(stored.env).every((value) => String(value).startsWith('msb-secret-'))).toBe(true)
    write(path, { env: settings.env, modelProviders: {} })
    prepareMicrosandboxLaunch(opts)
    expect(readFileSync(path, 'utf8')).not.toMatch(/fixture-bad|fixture-no-url|fixture-unknown|PRIVATE_KEY/)
  })

  it('keeps OAuth-only native, skips symlinked sources and refuses malformed settings without quoting keys', () => {
    const opts = fixture(),
      source = join(opts.source, 'settings.json')
    write(source, { security: { auth: { selectedType: 'qwen-oauth' } } })
    write(join(opts.source, 'oauth_creds.json'), oauth)
    expect(prepareMicrosandboxCredentials(opts.runtimeId, opts.runtime, opts.stateSourceEnv)).toBeUndefined()
    const launch = prepareMicrosandboxLaunch(opts)
    expect(JSON.parse(readFileSync(join(launch.env.QWEN_HOME!, 'oauth_creds.json'), 'utf8'))).toEqual(oauth)
    rmSync(source)
    const actual = join(opts.root, 'actual.json')
    write(actual, config())
    symlinkSync(actual, source)
    expect(prepareMicrosandboxCredentials(opts.runtimeId, opts.runtime, opts.stateSourceEnv)).toBeUndefined()
    rmSync(source)
    write(source, '{"env":{"MODEL_KEY":"fixture-invalid')
    expect(() => prepareMicrosandboxLaunch(opts)).toThrow('Cannot read the host Qwen settings file')
  })
})
