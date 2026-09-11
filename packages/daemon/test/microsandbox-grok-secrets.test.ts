import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'
import { prepareMicrosandboxCredentials } from '../src/microsandbox/secrets.js'
import { discoverSeededRuntimeCredentials } from '../src/runtimes/runtime-seeded-credentials.js'
import { prepareRuntimeHome } from '../src/runtimes/runtime-home.js'

const roots: string[] = []
const key = 'fixture-grok-model-key'
const oauth = { key: 'fixture-oauth', auth_mode: 'web_login', create_time: '2026-01-01T00:00:00Z', user_id: 'fixture' }
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
function fixture(relocated = false) {
  const root = mkdtempSync(join(tmpdir(), 'ac-grok-api-'))
  roots.push(root)
  const hostHome = join(root, 'host')
  const source = join(hostHome, relocated ? 'configured-grok' : '.grok')
  const authPath = relocated ? join(root, 'login.json') : join(source, 'auth.json')
  const scopeDir = join(root, 'agent')
  const cwd = join(scopeDir, 'workspace')
  mkdirSync(cwd, { recursive: true })
  return {
    root,
    source,
    authPath,
    runtimeId: 'grok-build',
    runtime: { command: 'grok', args: ['agent', 'stdio'], env: [] },
    scopeDir,
    cwd,
    mounts: [],
    stateSourceEnv: { HOME: hostHome, ...(relocated ? { GROK_HOME: source, GROK_AUTH_PATH: authPath } : {}) }
  }
}
const modelConfig = (value = key) =>
  stringifyToml({
    model: { custom: { api_key: value, base_url: 'https://api.example.test/v1', model: 'fixture-model' } },
    models: { default: 'custom' },
    extra_headers: { Authorization: `Bearer ${value}` },
    timestamp: new Date('2026-01-01T00:00:00Z')
  })
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('discovers config-only keys, including conditional arrays, without changing native key values', () => {
  const opts = fixture(true)
  write(join(opts.source, 'config.toml'), modelConfig())
  write(
    join(opts.source, 'requirements.toml'),
    '[[version_overrides]]\n[version_overrides.model.other]\napi_key="fixture-conditional"\n'
  )
  expect(discoverSeededRuntimeCredentials('grok-build', opts.stateSourceEnv)).toEqual({
    paths: [join(opts.source, 'config.toml'), join(opts.source, 'requirements.toml')],
    providers: ['xai']
  })
  const nativeHome = prepareRuntimeHome('grok-build', join(opts.root, 'native'), opts.stateSourceEnv)
  expect(readFileSync(join(nativeHome, '.grok/config.toml'), 'utf8')).toContain(key)
  write(join(opts.source, 'config.toml'), '[extensions.example]\napi_key="fixture-unrelated"\n')
  rmSync(join(opts.source, 'requirements.toml'))
  expect(discoverSeededRuntimeCredentials('grok-build', opts.stateSourceEnv).paths).toEqual([])
})

describe.skipIf(process.platform !== 'linux')('microsandbox Grok API credentials', () => {
  it.each([false, true])(
    'protects model keys and preserves native OAuth and guest settings, relocated=%s',
    (relocated) => {
      const opts = fixture(relocated)
      const configPath = join(opts.source, 'config.toml')
      write(configPath, modelConfig())
      write(opts.authPath, JSON.stringify({ 'https://accounts.x.ai/sign-in': oauth }))
      write(join(opts.source, 'auth-backup.json'), JSON.stringify({ key }))
      if (relocated)
        write(join(opts.source, 'auth.json'), JSON.stringify({ ignored: { ...oauth, key: 'ignored-token' } }))
      const launch = prepareMicrosandboxLaunch(opts)
      const secret = launch.microsandbox.secrets![0]!
      expect(secret.host).toEqual(['api.example.test'])
      expect(secret.readValue()).toBe(key)
      expect(launch.env.XAI_API_KEY).toBeUndefined()
      expect(JSON.stringify(launch)).not.toContain(key)
      const guest = launch.env.GROK_HOME!
      const config = parseToml(readFileSync(join(guest, 'config.toml'), 'utf8'))
      expect(config).toEqual(parseToml(modelConfig(secret.placeholder)))
      expect(existsSync(join(guest, 'auth-backup.json'))).toBe(false)
      expect(JSON.parse(readFileSync(launch.env.GROK_AUTH_PATH!, 'utf8'))).toEqual({
        'https://accounts.x.ai/sign-in': oauth
      })
      write(
        launch.env.GROK_AUTH_PATH!,
        JSON.stringify({ 'https://accounts.x.ai/sign-in': { ...oauth, key: 'refreshed-oauth' } })
      )
      write(
        join(guest, 'config.toml'),
        modelConfig(secret.placeholder).replace('api.example.test', 'guest-chosen.example.test')
      )
      write(configPath, modelConfig('fixture-rotated'))
      const resumed = prepareMicrosandboxLaunch(opts)
      expect(resumed.microsandbox.secrets![0]!.readValue()).toBe('fixture-rotated')
      expect(resumed.microsandbox.secrets![0]!.host).toEqual(secret.host)
      expect(readFileSync(join(guest, 'config.toml'), 'utf8')).toContain('guest-chosen.example.test')
      expect(readFileSync(launch.env.GROK_AUTH_PATH!, 'utf8')).toContain('refreshed-oauth')
      expect(readFileSync(opts.authPath, 'utf8')).not.toContain('refreshed-oauth')
      expect(() =>
        prepareMicrosandboxLaunch({
          ...opts,
          mounts: [{ source: configPath, target: '/raw-config', mode: 'readonly' }]
        })
      ).toThrow(/protected host/)
    }
  )

  it('deduplicates keys and withholds unresolved, conditional, managed and cached API credentials', () => {
    const opts = fixture()
    write(
      join(opts.source, 'config.toml'),
      stringifyToml({
        model: {
          a: { api_key: key, base_url: 'https://a.example.test' },
          b: { api_key: key, base_url: 'https://b.example.test' },
          inherited: { api_key: 'fixture-inherited' },
          http: { api_key: 'fixture-http', base_url: 'http://api.example.test' },
          interpolation: { api_key: '$UNRESOLVED', base_url: 'https://api.example.test' }
        },
        version_overrides: [{ model: { c: { api_key: 'fixture-conditional', base_url: 'https://c.example.test' } } }]
      })
    )
    write(
      join(opts.source, 'managed_config.toml'),
      '[model.managed]\napi_key="fixture-managed"\nbase_url="https://managed.example.test"\n'
    )
    write(
      opts.authPath,
      JSON.stringify({
        'xai::api_key': { ...oauth, key: 'fixture-cached', auth_mode: 'api_key' },
        'https://accounts.x.ai/sign-in': oauth
      })
    )
    const launch = prepareMicrosandboxLaunch(opts)
    expect(launch.microsandbox.secrets).toHaveLength(1)
    expect(launch.microsandbox.secrets![0]!.host).toEqual(['a.example.test', 'b.example.test'])
    for (const name of ['config.toml', 'managed_config.toml', 'auth.json']) {
      const text = readFileSync(join(launch.env.GROK_HOME!, name), 'utf8')
      expect(text).not.toMatch(/fixture-(grok|inherited|http|conditional|managed|cached)|\$UNRESOLVED/)
      expect(text).toContain('msb-secret-')
    }
    expect(readFileSync(launch.env.GROK_AUTH_PATH!, 'utf8')).toContain('fixture-oauth')
    const source = join(opts.source, 'config.toml')
    write(source, readFileSync(source, 'utf8').replace(key, 'fixture-rotated'))
    const resumed = prepareMicrosandboxLaunch(opts)
    const models = parseToml(readFileSync(join(launch.env.GROK_HOME!, 'config.toml'), 'utf8')).model
    expect(models).toMatchObject({
      a: {
        api_key: resumed.microsandbox.secrets!.find((secret) => secret.readValue() === 'fixture-rotated')!.placeholder
      },
      b: { api_key: resumed.microsandbox.secrets!.find((secret) => secret.readValue() === key)!.placeholder }
    })
  })

  it('keeps OAuth-only native and refuses malformed files without echoing secrets', () => {
    const opts = fixture()
    write(opts.authPath, JSON.stringify({ 'https://accounts.x.ai/sign-in': oauth }))
    expect(prepareMicrosandboxCredentials(opts.runtimeId, opts.runtime, opts.stateSourceEnv)).toBeUndefined()
    const target = join(opts.root, 'symlink-config')
    write(target, modelConfig())
    symlinkSync(target, join(opts.source, 'config.toml'))
    expect(prepareMicrosandboxCredentials(opts.runtimeId, opts.runtime, opts.stateSourceEnv)).toBeUndefined()
    rmSync(join(opts.source, 'config.toml'))
    write(join(opts.source, 'config.toml'), 'api_key="fixture-secret-error')
    expect(() => prepareMicrosandboxLaunch(opts)).toThrow('Cannot read the host Grok credential/configuration file')
    write(join(opts.source, 'config.toml'), modelConfig())
    const launch = prepareMicrosandboxLaunch(opts)
    write(join(launch.env.GROK_HOME!, 'config.toml'), 'api_key="fixture-retained-secret')
    expect(() => prepareMicrosandboxLaunch(opts)).toThrow('Cannot read the Grok credential/configuration file')
  })
})
