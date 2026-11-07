import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sealHostProviderKeys } from '../src/credential-proxy/host-keys.js'
import type { ProviderSlot } from '../src/credential-proxy/provider-route.js'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'
import {
  prepareAmbientCredentials,
  prepareMicrosandboxCredentials,
  type SecretBinding
} from '../src/microsandbox/secrets.js'

// github-app-git-credentials.md, Provider keys: Cline's saved API keys behind placeholders in a VM and in srt.
const KEY = 'fixture-cline-shared-key'
const GATEWAY_KEY = 'fixture-cline-gateway-key'
const runtime = { command: 'cline', args: ['--acp'], env: [] }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

function entry(settings: Record<string, unknown>) {
  return { settings, updatedAt: '2026-01-01T00:00:00.000Z', tokenSource: 'manual' }
}

const OAUTH = { provider: 'cline', auth: { accessToken: 'fixture-oauth-access', apiKey: 'fixture-oauth-beside' } }
const AWS = { provider: 'bedrock', aws: { accessKey: 'fixture-aws-access', secretKey: 'fixture-aws-secret' } }

function fixture(providers: Record<string, Record<string, unknown>>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-cline-api-')))
  roots.push(root)
  const HOME = join(root, 'host')
  const source = join(HOME, '.cline', 'data', 'settings', 'providers.json')
  const stored = {
    version: 1,
    lastUsedProvider: 'anthropic',
    modes: {},
    providers: Object.fromEntries(Object.entries(providers).map(([id, settings]) => [id, entry(settings)]))
  }
  write(source, stored)
  const scopeDir = join(root, 'agent')
  const cwd = join(scopeDir, 'workspace')
  mkdirSync(cwd, { recursive: true })
  return { HOME, source, stored, scopeDir, cwd }
}

const providers = {
  anthropic: { provider: 'anthropic', apiKey: KEY },
  gemini: { provider: 'gemini', auth: { apiKey: KEY } },
  'openai-compatible': {
    provider: 'openai-compatible',
    apiKey: GATEWAY_KEY,
    baseUrl: 'https://gateway.example.test/v1'
  },
  together: { provider: 'together', apiKey: 'fixture-cline-unrouted-key' },
  plain: { provider: 'openai-compatible', apiKey: 'fixture-cline-plain-key', baseUrl: 'http://plain.example.test/v1' },
  cline: OAUTH,
  bedrock: AWS
}

describe('Cline saved API keys', () => {
  it("binds each key to its provider's default or configured HTTPS host and leaves sign-ins as they are", () => {
    const { HOME } = fixture(providers)
    const credentials = prepareMicrosandboxCredentials('cline', runtime, { HOME })!
    expect(credentials.secrets.map((secret) => [secret.host, secret.readValue()])).toEqual([
      [['api.anthropic.com', 'generativelanguage.googleapis.com'], KEY],
      [['gateway.example.test'], GATEWAY_KEY]
    ])
    expect(
      credentials.secrets.every((secret) => /^msb-secret-AC_CLINE_API_[0-9A-F]{16}$/.test(secret.placeholder))
    ).toBe(true)
    // A key with no supported route stays hidden without authorizing any host.
    expect([...credentials.replacements.keys()].sort()).toEqual(
      [GATEWAY_KEY, KEY, 'fixture-cline-plain-key', 'fixture-cline-unrouted-key'].sort()
    )
    expect(JSON.stringify(credentials)).not.toMatch(/fixture-(oauth|aws)/)
  })

  it("passes each binding to an srt launch's placeholder factory", () => {
    const { HOME } = fixture({ anthropic: providers.anthropic, 'openai-compatible': providers['openai-compatible'] })
    const bindings: SecretBinding[] = []
    const credentials = prepareAmbientCredentials('cline', runtime, { HOME }, {}, (binding) => {
      bindings.push(binding)
      return `sealed-${binding.env}`
    })!
    expect(bindings).toEqual([
      {
        env: expect.stringMatching(/^AC_CLINE_API_/),
        provider: 'anthropic',
        hosts: ['api.anthropic.com'],
        defaultHost: 'api.anthropic.com'
      },
      { env: expect.stringMatching(/^AC_CLINE_API_/), provider: 'openai-compatible', hosts: ['gateway.example.test'] }
    ])
    expect(credentials.replacements.get(KEY)).toBe(`sealed-${bindings[0]!.env}`)
  })

  it('seals a slot per key on Linux and reads it again from the host file', async () => {
    const { HOME, source, stored } = fixture({ anthropic: providers.anthropic })
    const sealed: ProviderSlot[] = []
    const seal = (slot: ProviderSlot) => {
      sealed.push(slot)
      return `acph1_fixture-${slot.id}`
    }
    const host = { runtimeId: 'cline', runtime, hostEnv: { HOME }, explicitEnv: {} }
    expect(sealHostProviderKeys({ ...host, platform: 'darwin' }, seal)).toEqual({
      kept: 'projecting a sign-in file into the private HOME needs Linux'
    })
    const result = sealHostProviderKeys({ ...host, platform: 'linux' }, seal)
    if (!result || 'kept' in result) throw new Error('expected sealed keys')
    expect(result.slots.map(({ slot }) => slot)).toEqual([
      {
        id: expect.stringMatching(/^host:cline:AC_CLINE_API_/),
        provider: 'anthropic',
        host: 'api.anthropic.com',
        port: 443,
        saas: true
      }
    ])
    write(source, { ...stored, providers: { anthropic: entry({ provider: 'anthropic', apiKey: 'fixture-rotated' }) } })
    await expect(result.slots[0]!.read()).resolves.toBe('fixture-rotated')
    rmSync(source)
    await expect(result.slots[0]!.read()).rejects.toThrow(/no longer holds AC_CLINE_API_/)
  })

  it('keeps every key of a launch whose shared key reaches two hosts', () => {
    const { HOME } = fixture({ anthropic: providers.anthropic, gemini: providers.gemini })
    const result = sealHostProviderKeys(
      { runtimeId: 'cline', runtime, hostEnv: { HOME }, explicitEnv: {}, platform: 'linux' },
      (slot) => slot.id
    )
    expect(result).toEqual({ kept: expect.stringMatching(/^AC_CLINE_API_\w+ reach no single HTTPS host/) })
  })

  it('ignores a missing, unversioned or sign-in-only file and reports a malformed one without its contents', () => {
    const { HOME, source } = fixture({ cline: OAUTH })
    expect(prepareMicrosandboxCredentials('cline', runtime, { HOME })).toBeUndefined()
    write(source, { providers: { anthropic: entry(providers.anthropic) } })
    expect(prepareMicrosandboxCredentials('cline', runtime, { HOME })).toBeUndefined()
    rmSync(source)
    expect(prepareMicrosandboxCredentials('cline', runtime, { HOME })).toBeUndefined()
    write(source, `${KEY}{`)
    expect(() => prepareMicrosandboxCredentials('cline', runtime, { HOME })).toThrow(
      /^Cannot read the host Cline provider settings file$/
    )
  })
})

// The projection descends by file descriptor, which only Linux provides.
describe.skipIf(process.platform !== 'linux')('Cline saved API keys in a VM', () => {
  it('projects provider settings with placeholders and leaves the host file unchanged', () => {
    const { HOME, source, scopeDir, cwd } = fixture(providers)
    const launch = prepareMicrosandboxLaunch({
      runtimeId: 'cline',
      runtime,
      scopeDir,
      cwd,
      mounts: [],
      stateSourceEnv: { HOME }
    })
    const secrets = launch.microsandbox.secrets!
    expect(JSON.stringify(launch)).not.toContain(KEY)
    const projected = JSON.parse(readFileSync(join(launch.env.HOME!, '.cline/data/settings/providers.json'), 'utf8'))
    const shared = secrets.find((secret) => secret.readValue() === KEY)!.placeholder
    expect(projected.providers.anthropic.settings.apiKey).toBe(shared)
    expect(projected.providers.gemini.settings.auth.apiKey).toBe(shared)
    expect(projected.providers['openai-compatible'].settings.apiKey).toBe(
      secrets.find((secret) => secret.readValue() === GATEWAY_KEY)!.placeholder
    )
    expect(projected.providers.together.settings.apiKey).toMatch(/^msb-secret-AC_CLINE_API_/)
    expect(projected.providers.cline.settings).toEqual(OAUTH)
    expect(projected.providers.bedrock.settings).toEqual(AWS)
    expect(readFileSync(source, 'utf8')).toContain(KEY)
  })

  it('puts the placeholder in each bound field of a retained copy, even one holding a key the host rotated away', () => {
    const { HOME, stored } = fixture({ anthropic: providers.anthropic, gemini: providers.gemini })
    const home = join(realpathSync(mkdtempSync(join(tmpdir(), 'ac-cline-home-'))), 'home')
    roots.push(dirname(home))
    const target = join(home, '.cline', 'data', 'settings', 'providers.json')
    write(target, {
      ...stored,
      providers: {
        anthropic: entry({ provider: 'anthropic', apiKey: 'fixture-cline-old-key' }),
        gemini: entry({ provider: 'gemini', auth: { apiKey: 'fixture-cline-old-key' } })
      }
    })
    const credentials = prepareAmbientCredentials(
      'cline',
      runtime,
      { HOME },
      {},
      (binding) => `acph1_fixture-${binding.env}`
    )!
    credentials.preparePrivateHome(home)
    const projected = readFileSync(target, 'utf8')
    expect(projected).not.toContain('fixture-cline-old-key')
    const placeholder = credentials.replacements.get(KEY)!
    expect(JSON.parse(projected).providers.anthropic.settings.apiKey).toBe(placeholder)
    expect(JSON.parse(projected).providers.gemini.settings.auth.apiKey).toBe(placeholder)
  })
})
