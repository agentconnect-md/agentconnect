import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'
import { prepareMicrosandboxCredentials } from '../src/microsandbox/secrets.js'

const roots: string[] = []
const key = 'fixture-amp-api-key'
const name = 'apiKey@https://amp.example.test/'
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
function fixture(relocated = false) {
  const root = mkdtempSync(join(tmpdir(), 'ac-amp-api-'))
  roots.push(root)
  const home = join(root, 'host')
  const data = join(home, relocated ? 'data' : '.local/share')
  const config = join(home, relocated ? 'config' : '.config')
  const source = join(data, 'amp/secrets.json')
  const settings = join(config, 'amp', relocated ? 'custom.json' : 'settings.json')
  const scopeDir = join(root, 'agent')
  const cwd = join(scopeDir, 'workspace')
  mkdirSync(cwd, { recursive: true })
  write(source, { [name]: key, 'oauth@example': { access: 'fixture-oauth' } })
  write(settings, `// Native JSONC settings\n{"amp.url":"https://amp.example.test/","copy":"${key}"}`)
  return {
    source,
    settings,
    runtimeId: 'amp-acp',
    runtime: { command: 'amp-acp', args: [], env: [] },
    scopeDir,
    cwd,
    mounts: [],
    stateSourceEnv: {
      HOME: home,
      ...(relocated ? { XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, AMP_SETTINGS_FILE: settings } : {})
    }
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('microsandbox Amp file credentials', () => {
  it.each([false, true])('projects native file logins and settings, relocated=%s', (relocated) => {
    const opts = fixture(relocated)
    const launch = prepareMicrosandboxLaunch(opts)
    const secret = launch.microsandbox.secrets![0]!
    expect(secret.host).toEqual(['amp.example.test'])
    expect(secret.readValue()).toBe(key)
    expect(JSON.stringify(launch)).not.toContain(key)
    expect(launch.env.AMP_API_KEY).toBeUndefined()
    expect(JSON.parse(readFileSync(join(launch.env.XDG_DATA_HOME!, 'amp/secrets.json'), 'utf8'))).toEqual({
      [name]: secret.placeholder,
      'oauth@example': { access: 'fixture-oauth' }
    })
    const settings = launch.env.AMP_SETTINGS_FILE ?? join(launch.env.XDG_CONFIG_HOME!, 'amp/settings.json')
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
      'amp.url': 'https://amp.example.test/',
      copy: secret.placeholder
    })
    expect(() =>
      prepareMicrosandboxLaunch({
        ...opts,
        mounts: [{ source: opts.source, target: '/raw-credentials', mode: 'readonly' }]
      })
    ).toThrow(/protected host/)
    expect(readFileSync(opts.source, 'utf8')).toContain(key)
  })

  it('unifies shared keys and leaves unsupported services protected without injection', () => {
    const opts = fixture()
    const credentials = {
      [name]: key,
      'apiKey@https://second.example.test': key,
      'apiKey@http://plain.example.test': 'fixture-plain-key',
      'apiKey@https://port.example.test:8443': 'fixture-port-key',
      'apiKey@https://user@userinfo.example.test': 'fixture-userinfo-key',
      'apiKey@invalid': 'fixture-invalid-key',
      'mcp@example': { token: 'fixture-mcp-token' }
    }
    write(opts.source, credentials)
    const launch = prepareMicrosandboxLaunch(opts)
    expect(launch.microsandbox.secrets).toHaveLength(1)
    expect(launch.microsandbox.secrets![0]!.host).toEqual(['amp.example.test', 'second.example.test'])
    const privateAuth = JSON.parse(readFileSync(join(launch.env.XDG_DATA_HOME!, 'amp/secrets.json'), 'utf8'))
    for (const name of Object.keys(credentials).filter((name) => name.startsWith('apiKey@')))
      expect(privateAuth[name]).toMatch(/^msb-secret-AC_AMP_API_/)
    expect(privateAuth[name]).toBe(privateAuth['apiKey@https://second.example.test'])
    expect(privateAuth['mcp@example']).toEqual(credentials['mcp@example'])
  })

  it('preserves private state on key rotation and rejects redirected private files', () => {
    const opts = fixture()
    const first = prepareMicrosandboxLaunch(opts)
    const authPath = join(first.env.XDG_DATA_HOME!, 'amp/secrets.json')
    const credentials = JSON.parse(readFileSync(authPath, 'utf8'))
    credentials['oauth@example'].access = 'fixture-refreshed'
    credentials['apiKey@https://guest.example.test'] = 'fixture-guest-login'
    write(authPath, credentials)
    write(opts.source, { [name]: 'fixture-rotated-key' })
    const next = prepareMicrosandboxLaunch(opts)
    expect(next.microsandbox.secrets![0]!.placeholder).toBe(first.microsandbox.secrets![0]!.placeholder)
    expect(next.microsandbox.secrets![0]!.readValue()).toBe('fixture-rotated-key')
    expect(next.microsandbox.secrets![0]!.host).toEqual(['amp.example.test'])
    expect(JSON.parse(readFileSync(authPath, 'utf8'))).toEqual(credentials)
    rmSync(authPath)
    symlinkSync(opts.source, authPath)
    expect(() => prepareMicrosandboxLaunch(opts)).toThrow(/symlink/)
    expect(readFileSync(opts.source, 'utf8')).toContain('fixture-rotated-key')
  })
})

it('ignores missing native logins and reports malformed credentials without their contents', () => {
  const opts = fixture()
  rmSync(opts.source)
  expect(prepareMicrosandboxCredentials('amp-acp', opts.runtime, opts.stateSourceEnv)).toBeUndefined()
  write(opts.source, `${key}{`)
  expect(() => prepareMicrosandboxCredentials('amp-acp', opts.runtime, opts.stateSourceEnv)).toThrow(
    'Cannot read the host Amp credential file'
  )
})
