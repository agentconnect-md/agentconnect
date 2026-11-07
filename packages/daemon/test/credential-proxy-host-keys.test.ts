import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostKeySlot, sealHostProviderKeys } from '../src/credential-proxy/host-keys.js'
import type { ProviderSlot } from '../src/credential-proxy/provider-route.js'
import {
  ambientCredentialRuntime,
  prepareAmbientCredentials,
  prepareMicrosandboxCredentials,
  type SecretBinding
} from '../src/microsandbox/secrets.js'
import { prepareOpenCodeSecrets } from '../src/microsandbox/opencode-secrets.js'
import { openCodeKeyEnv } from '../src/runtimes/opencode-host-keys.js'
import { fakeOpenCode, openCodeKeyEntry } from './opencode-support.js'

// github-app-git-credentials.md, Provider keys: the preparers' placeholder factory, and the host key slots srt seals with it.
const CLAUDE_KEY = 'fixture-claude-file-key'
const ENV_KEY = 'fixture-claude-env-key'
const CODEX_KEY = 'fixture-codex-file-key'
const claude = { command: 'node', args: ['claude-agent-acp'], env: [] }
const codex = { command: 'node', args: ['codex-acp'], env: [] }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hostHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-host-keys-')))
  roots.push(root)
  return root
}

function write(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}

/** A factory that records each binding and seals nothing. */
function recorder() {
  const bindings: SecretBinding[] = []
  return {
    bindings,
    placeholder: (binding: SecretBinding) => {
      bindings.push(binding)
      return `sealed-${binding.env}`
    }
  }
}

describe('the preparers placeholder factory', () => {
  it('keeps msb-secret placeholders by default and passes each binding to an injected factory', () => {
    const HOME = hostHome()
    write(join(HOME, '.claude.json'), { primaryApiKey: CLAUDE_KEY })
    const vm = prepareMicrosandboxCredentials('claude-acp', claude, { HOME }, {})
    expect(vm?.secrets.map((secret) => secret.placeholder)).toEqual(['msb-secret-AC_CLAUDE_API_KEY'])
    const { bindings, placeholder } = recorder()
    const srt = prepareAmbientCredentials('claude-acp', claude, { HOME, ANTHROPIC_API_KEY: ENV_KEY }, {}, placeholder)
    expect(bindings).toEqual([
      {
        env: 'AC_CLAUDE_API_KEY',
        provider: 'anthropic',
        hosts: ['api.anthropic.com'],
        defaultHost: 'api.anthropic.com'
      },
      {
        env: 'ANTHROPIC_API_KEY',
        provider: 'anthropic',
        hosts: ['api.anthropic.com'],
        defaultHost: 'api.anthropic.com'
      }
    ])
    expect(srt?.secrets.map((secret) => [secret.env, secret.placeholder])).toEqual([
      ['AC_CLAUDE_API_KEY', 'sealed-AC_CLAUDE_API_KEY'],
      ['ANTHROPIC_API_KEY', 'sealed-ANTHROPIC_API_KEY']
    ])
    // A VM passes the runtime's own variable through, as it did.
    expect(
      prepareMicrosandboxCredentials('claude-acp', claude, { HOME, ANTHROPIC_API_KEY: ENV_KEY }, {})?.secrets.map(
        (secret) => secret.env
      )
    ).toEqual(['AC_CLAUDE_API_KEY'])
  })

  // The projection descends by file descriptor, which only Linux provides.
  it.skipIf(process.platform !== 'linux')("writes the factory's placeholder into a projected Codex auth.json", () => {
    const HOME = hostHome()
    write(join(HOME, '.codex', 'auth.json'), { auth_mode: 'apikey', OPENAI_API_KEY: CODEX_KEY })
    const { bindings, placeholder } = recorder()
    const credentials = prepareAmbientCredentials('codex-acp', codex, { HOME }, {}, placeholder)!
    expect(bindings).toEqual([
      { env: 'AC_CODEX_API_KEY', provider: 'openai', hosts: ['api.openai.com'], defaultHost: 'api.openai.com' }
    ])
    expect(credentials.shareNativeCredentials).toBe(false)
    const home = join(hostHome(), 'private')
    mkdirSync(home)
    credentials.preparePrivateHome(home)
    expect(JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8'))).toEqual({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'sealed-AC_CODEX_API_KEY'
    })
  })

  it("binds Codex's key variable to no host when OPENAI_BASE_URL may redirect it", () => {
    const { bindings, placeholder } = recorder()
    prepareAmbientCredentials(
      'codex-acp',
      codex,
      { HOME: hostHome(), OPENAI_API_KEY: CODEX_KEY },
      { OPENAI_BASE_URL: 'https://gateway.example.test/v1' },
      placeholder
    )
    expect(bindings).toEqual([{ env: 'OPENAI_API_KEY', provider: 'openai', hosts: [], defaultHost: 'api.openai.com' }])
  })

  it.skipIf(process.platform === 'win32')('asks once for a key two OpenCode providers share, with both hosts', () => {
    const HOME = hostHome()
    const { PATH } = fakeOpenCode(HOME, [
      openCodeKeyEntry('anthropic', 'fixture-shared-key'),
      openCodeKeyEntry('openai', 'fixture-shared-key')
    ])
    const { bindings, placeholder } = recorder()
    const credentials = prepareOpenCodeSecrets({ HOME, PATH }, {}, placeholder)!
    const env = openCodeKeyEnv('anthropic')
    expect(bindings).toEqual([
      {
        env,
        provider: 'anthropic',
        hosts: ['api.anthropic.com', 'api.openai.com'],
        defaultHost: 'api.anthropic.com'
      }
    ])
    expect(credentials.replacements.get('fixture-shared-key')).toBe(`sealed-${env}`)
  })

  it('knows a runtime by the adapter it launches, and only those srt protects', () => {
    expect(ambientCredentialRuntime('claude', claude)).toBe('claude-acp')
    expect(ambientCredentialRuntime('my-codex', codex)).toBe('codex-acp')
    expect(ambientCredentialRuntime('opencode', undefined)).toBe('opencode')
    expect(ambientCredentialRuntime('pi-acp', undefined)).toBeUndefined()
  })
})

describe('host key slots', () => {
  const sealed: ProviderSlot[] = []
  const seal = (slot: ProviderSlot) => {
    sealed.push(slot)
    return `acph1_fixture-${slot.id}`
  }
  afterEach(() => {
    sealed.length = 0
  })

  it("seals a slot per key at the runtime's endpoint and reads the key again from its file", () => {
    const HOME = hostHome()
    const auth = join(HOME, '.codex', 'auth.json')
    write(auth, { auth_mode: 'apikey', OPENAI_API_KEY: CODEX_KEY })
    const source = { runtimeId: 'codex', runtime: codex, hostEnv: { HOME }, explicitEnv: {} }
    expect(sealHostProviderKeys({ ...source, platform: 'darwin' }, seal)).toEqual({
      kept: 'projecting a sign-in file into the private HOME needs Linux'
    })
    sealed.length = 0
    const result = sealHostProviderKeys({ ...source, platform: 'linux' }, seal)
    if (!result || 'kept' in result) throw new Error('expected sealed keys')
    expect(result.slots.map(({ slot }) => slot)).toEqual([
      { id: 'host:codex-acp:AC_CODEX_API_KEY', provider: 'openai', host: 'api.openai.com', port: 443, saas: true }
    ])
    expect(sealed).toEqual(result.slots.map(({ slot }) => slot))
    expect(result.credentials.secrets[0]!.placeholder).toBe('acph1_fixture-host:codex-acp:AC_CODEX_API_KEY')
    write(auth, { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-rotated-key' })
    expect(result.slots[0]!.read()).toBe('fixture-rotated-key')
    write(join(HOME, '.codex', 'config.toml'), 'openai_base_url = "https://gateway.example.test/v1"\n')
    expect(() => result.slots[0]!.read()).toThrow(/endpoint for AC_CODEX_API_KEY changed/)
    rmSync(auth)
    expect(() => result.slots[0]!.read()).toThrow(/no longer holds AC_CODEX_API_KEY/)
  })

  it("marks an operator's endpoint as not the provider's own", () => {
    const result = sealHostProviderKeys(
      {
        runtimeId: 'claude-acp',
        runtime: claude,
        hostEnv: { HOME: hostHome(), ANTHROPIC_API_KEY: ENV_KEY },
        explicitEnv: { ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic' }
      },
      seal
    )
    if (!result || 'kept' in result) throw new Error('expected sealed keys')
    expect(result.slots.map(({ slot }) => slot)).toEqual([
      {
        id: 'host:claude-acp:ANTHROPIC_API_KEY',
        provider: 'anthropic',
        host: 'gateway.example.test',
        port: 443,
        saas: false
      }
    ])
    expect(result.slots[0]!.read()).toBe(ENV_KEY)
  })

  it('keeps every key of a source the proxy cannot serve, and says why without the key', () => {
    const unbound = sealHostProviderKeys(
      {
        runtimeId: 'claude-acp',
        runtime: claude,
        hostEnv: { HOME: hostHome(), ANTHROPIC_API_KEY: ENV_KEY },
        explicitEnv: { ANTHROPIC_BASE_URL: 'http://gateway.example.test' }
      },
      seal
    )
    expect(unbound).toEqual({ kept: 'ANTHROPIC_API_KEY reach no single HTTPS host the proxy recognizes' })
    const refused = sealHostProviderKeys(
      {
        runtimeId: 'dsh-acp',
        runtime: undefined,
        hostEnv: { HOME: hostHome(), DEEPSEEK_API_KEY: 'fixture-deepseek-key' },
        explicitEnv: { DEEPSEEK_BASE_URL: 'https://gateway.example.test' }
      },
      seal
    )
    expect(refused).toEqual({ kept: expect.stringMatching(/requires https:\/\/api\.deepseek\.com/) })
    expect(JSON.stringify([unbound, refused])).not.toMatch(/fixture-/)
    expect(
      sealHostProviderKeys({ runtimeId: 'pi-acp', runtime: undefined, hostEnv: {}, explicitEnv: {} }, seal)
    ).toBeUndefined()
  })

  it('needs exactly one host for a slot', () => {
    const binding = { env: 'X_KEY', provider: 'example', defaultHost: 'api.example.test' }
    expect(hostKeySlot('opencode', { ...binding, hosts: [] })).toBeUndefined()
    expect(hostKeySlot('opencode', { ...binding, hosts: ['a.example.test', 'b.example.test'] })).toBeUndefined()
    expect(hostKeySlot('opencode', { ...binding, hosts: ['api.example.test'] })?.saas).toBe(true)
  })
})
