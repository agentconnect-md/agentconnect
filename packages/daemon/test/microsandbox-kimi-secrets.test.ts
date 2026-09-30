import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { discoverRuntimeCredentials } from '../src/runtimes/runtime-credential-discovery.js'
import { microsandboxCredentialStep, prepareMicrosandboxCredentials } from '../src/microsandbox/secrets.js'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ac-kimi-secret-'))
  roots.push(root)
  const source = join(root, 'host', 'relocated')
  const guest = join(root, 'guest')
  mkdirSync(source, { recursive: true })
  mkdirSync(guest)
  const config = {
    providers: {
      first: { type: 'openai', base_url: 'https://first.example.test/v1', api_key: 'fixture-key' },
      second: { type: 'anthropic', base_url: 'https://second.example.test', api_key: 'fixture-key' },
      unsupported: { type: 'openai', base_url: 'http://plain.example.test', api_key: 'fixture-unsupported' },
      oauth: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/example' } }
    }
  }
  const write = () => writeFileSync(join(source, 'config.toml'), stringify(config))
  write()
  writeFileSync(join(source, 'config.toml.bak'), stringify(config))
  const prepare = () =>
    prepareMicrosandboxCredentials('kimi', undefined, { HOME: join(root, 'host'), KIMI_CODE_HOME: source })!
  return { root, source, guest, config, write, prepare }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('Kimi file API-key projection', () => {
  it('shares bindings, hides unsupported keys and backup copies, and preserves OAuth configuration', () => {
    const f = fixture()
    const credentials = f.prepare()
    expect(
      discoverRuntimeCredentials('kimi', undefined, { HOME: join(f.root, 'host'), KIMI_CODE_HOME: f.source }).paths
    ).toContain(join(f.source, 'config.toml'))
    expect(credentials.secrets).toHaveLength(1)
    expect(credentials.secrets[0]!.host).toEqual(['first.example.test', 'second.example.test'])
    credentials.preparePrivateHome(f.guest)
    for (const name of ['config.toml', 'config.toml.bak']) {
      const text = readFileSync(join(f.guest, '.kimi-code', name), 'utf8')
      expect(text).not.toContain('fixture-key')
      expect(text).not.toContain('fixture-unsupported')
      expect((parse(text).providers as typeof f.config.providers).oauth).toEqual(f.config.providers.oauth)
    }
    expect(readFileSync(join(f.source, 'config.toml'), 'utf8')).toContain('fixture-key')
    expect(JSON.stringify(credentials)).not.toContain('fixture-key')
  })

  it('rotates host values without rewriting private settings or accepting a guest-authorized host', () => {
    const f = fixture()
    f.prepare().preparePrivateHome(f.guest)
    const path = join(f.guest, '.kimi-code', 'config.toml')
    const privateConfig = parse(readFileSync(path, 'utf8')) as typeof f.config
    privateConfig.providers.first.base_url = 'https://guest.example.test'
    writeFileSync(path, stringify(privateConfig))
    f.config.providers.first.api_key = f.config.providers.second.api_key = 'fixture-rotated'
    f.write()
    const credentials = f.prepare()
    credentials.preparePrivateHome(f.guest)
    expect(credentials.secrets[0]!.readValue()).toBe('fixture-rotated')
    expect(credentials.secrets[0]!.host).not.toContain('guest.example.test')
    expect((parse(readFileSync(path, 'utf8')).providers as typeof f.config.providers).first.base_url).toBe(
      'https://guest.example.test'
    )
  })

  it('keeps OAuth-only config seeding and the shared refresh directory', () => {
    const f = fixture()
    writeFileSync(join(f.source, 'config.toml'), stringify({ providers: { oauth: f.config.providers.oauth } }))
    const step = microsandboxCredentialStep('kimi', undefined, { HOME: join(f.root, 'host'), KIMI_CODE_HOME: f.source })
    expect(step.protectedCredentials).toBeUndefined()
    step.seedHome(f.root, f.guest)
    expect(
      (parse(readFileSync(join(f.guest, '.kimi-code', 'config.toml'), 'utf8')).providers as typeof f.config.providers)
        .oauth
    ).toEqual(f.config.providers.oauth)
    expect(step.credentials!.writablePaths).toEqual([join(f.source, 'credentials')])
  })

  it('refuses retained plaintext and new guest credentials rather than silently migrating them', () => {
    const f = fixture()
    const credentials = f.prepare()
    const dir = join(f.guest, '.kimi-code')
    mkdirSync(dir)
    writeFileSync(join(dir, 'config.toml'), stringify(f.config))
    expect(() => credentials.preparePrivateHome(f.guest)).toThrow(/new session/)
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toContain('fixture-key')
  })
})
