import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
import { prepareRuntimeHome } from '../src/runtimes/runtime-home.js'
import { fakeOpenCode, openCodeKeyEntry } from './opencode-support.js'
import { RUNTIME_KEY_FIXTURES } from './runtime-key-files-support.js'

// github-app-git-credentials.md, Provider keys: the preparers' placeholder factory, and the host key slots srt seals with it.
const CLAUDE_KEY = 'fixture-claude-file-key'
const ENV_KEY = 'fixture-claude-env-key'
const CODEX_KEY = 'fixture-codex-file-key'
// A slow export, and a timer that must fire while it runs.
const SLOW_EXPORT_SECONDS = 1
const CONCURRENT_TIMER_MS = 50
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
    // A VM binds the runtime's own variable too, beside the file's key, with its own placeholders.
    expect(
      prepareMicrosandboxCredentials('claude-acp', claude, { HOME, ANTHROPIC_API_KEY: ENV_KEY }, {})?.secrets.map(
        (secret) => [secret.env, secret.placeholder]
      )
    ).toEqual([
      ['AC_CLAUDE_API_KEY', 'msb-secret-AC_CLAUDE_API_KEY'],
      ['ANTHROPIC_API_KEY', 'msb-secret-ANTHROPIC_API_KEY']
    ])
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
    expect(ambientCredentialRuntime('pi-acp', undefined)).toBe('pi-acp')
    expect(ambientCredentialRuntime('goose', undefined)).toBeUndefined()
  })
})

describe.each(RUNTIME_KEY_FIXTURES)("$runtime's own key files", (fixture) => {
  const variable = new RegExp(`^${fixture.prefix}_[0-9A-F]{16}$`)
  const proxied = (binding: SecretBinding) => `acph1_fixture-${binding.env}`

  it('binds the key to the host its preparer names, with the VM placeholder by default', () => {
    const HOME = hostHome()
    fixture.seed(HOME)
    const { bindings, placeholder } = recorder()
    const credentials = prepareAmbientCredentials(fixture.runtime, undefined, { HOME }, {}, placeholder)!
    expect(bindings).toEqual([
      {
        env: expect.stringMatching(variable),
        provider: fixture.provider,
        hosts: [fixture.host],
        defaultHost: fixture.host
      }
    ])
    const env = bindings[0]!.env
    expect(credentials.secrets.map((secret) => [secret.env, secret.placeholder])).toEqual([[env, `sealed-${env}`]])
    expect(credentials.replacements.get(fixture.key)).toBe(`sealed-${env}`)
    expect(prepareMicrosandboxCredentials(fixture.runtime, undefined, { HOME })?.secrets[0]?.placeholder).toBe(
      `msb-secret-${env}`
    )
  })

  it('seals a slot at that host and reads the key again until it is gone', async () => {
    const HOME = hostHome()
    fixture.seed(HOME)
    const source = { runtimeId: fixture.runtime, runtime: undefined, hostEnv: { HOME }, explicitEnv: {} }
    const seal = (slot: ProviderSlot) => `acph1_fixture-${slot.id}`
    expect(sealHostProviderKeys({ ...source, platform: 'darwin' }, seal)).toEqual({
      kept: 'projecting a sign-in file into the private HOME needs Linux'
    })
    const result = sealHostProviderKeys({ ...source, platform: 'linux' }, seal)
    if (!result || 'kept' in result) throw new Error('expected sealed keys')
    const env = result.credentials.secrets[0]!.env
    expect(result.slots.map(({ slot }) => slot)).toEqual([
      { id: `host:${fixture.runtime}:${env}`, provider: fixture.provider, host: fixture.host, port: 443, saas: true }
    ])
    await expect(result.slots[0]!.read()).resolves.toBe(fixture.key)
    for (const entry of ['.pi', '.grok', '.qwen', '.omp', '.local', '.kimi-code', '.cline'])
      rmSync(join(HOME, entry), { recursive: true, force: true })
    await expect(result.slots[0]!.read()).rejects.toThrow(`this machine no longer holds ${env}`)
  })

  // The projection descends by file descriptor, which only Linux provides.
  it.skipIf(process.platform !== 'linux')(
    'projects a copy an earlier launch left in the clear, keeps the OAuth sign-in, and restores the key once unprotected',
    () => {
      const HOME = hostHome()
      fixture.seed(HOME)
      const root = hostHome()
      const home = join(root, 'home')
      fixture.seed(home)
      const credentials = prepareAmbientCredentials(fixture.runtime, undefined, { HOME }, {}, proxied)!
      const env = credentials.secrets[0]!.env
      credentials.preparePrivateHome(home)
      expect(fixture.stored(home)).toBe(`acph1_fixture-${env}`)
      if (fixture.oauth) expect(fixture.oauth.read(home)).toEqual(fixture.oauth.expected)
      // A launch the proxy no longer protects gets the host's key back in the same field.
      prepareRuntimeHome(fixture.runtime, root, { HOME }, home)
      expect(fixture.stored(home)).toBe(fixture.key)
      if (fixture.oauth) expect(fixture.oauth.read(home)).toEqual(fixture.oauth.expected)
    }
  )
})

describe('a runtime key file the proxy cannot serve', () => {
  const seal = (slot: ProviderSlot) => `acph1_fixture-${slot.id}`

  it('keeps every key when one names no host, and says why without the key', () => {
    const HOME = hostHome()
    write(join(HOME, '.pi', 'agent', 'auth.json'), {
      anthropic: { type: 'api_key', key: 'fixture-pi-key' },
      custom: { type: 'api_key', key: 'fixture-custom-key' }
    })
    const kept = sealHostProviderKeys(
      { runtimeId: 'pi-acp', runtime: undefined, hostEnv: { HOME }, explicitEnv: {}, platform: 'linux' },
      seal
    )
    expect(kept).toEqual({ kept: expect.stringMatching(/^PI_API_[0-9A-F]{16} reach no single HTTPS host/) })
    expect(JSON.stringify(kept)).not.toMatch(/fixture-/)
  })

  it("keeps Grok's sign-in key, whose host its file does not name", () => {
    const HOME = hostHome()
    write(join(HOME, '.grok', 'auth.json'), { 'xai::api_key': { auth_mode: 'api_key', key: 'fixture-grok-key' } })
    expect(
      sealHostProviderKeys(
        { runtimeId: 'grok-build', runtime: undefined, hostEnv: { HOME }, explicitEnv: {}, platform: 'linux' },
        seal
      )
    ).toEqual({ kept: expect.stringMatching(/^AC_GROK_API_[0-9A-F]{16} reach no single HTTPS host/) })
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

  it("seals a slot per key at the runtime's endpoint and reads the key again from its file", async () => {
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
    await expect(result.slots[0]!.read()).resolves.toBe('fixture-rotated-key')
    write(join(HOME, '.codex', 'config.toml'), 'openai_base_url = "https://gateway.example.test/v1"\n')
    await expect(result.slots[0]!.read()).rejects.toThrow(/endpoint for AC_CODEX_API_KEY changed/)
    rmSync(auth)
    await expect(result.slots[0]!.read()).rejects.toThrow(/no longer holds AC_CODEX_API_KEY/)
  })

  it("marks an operator's endpoint as not the provider's own", async () => {
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
    await expect(result.slots[0]!.read()).resolves.toBe(ENV_KEY)
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

  // The fake `opencode` is a shell script.
  it.skipIf(process.platform === 'win32')(
    "reads an OpenCode key again without blocking the daemon while the host's export runs",
    async () => {
      const HOME = hostHome()
      const { PATH } = fakeOpenCode(HOME, [openCodeKeyEntry('anthropic', 'fixture-opencode-key')])
      const source = { runtimeId: 'opencode', runtime: undefined, hostEnv: { HOME, PATH }, explicitEnv: {} }
      const result = sealHostProviderKeys(source, seal)
      if (!result || 'kept' in result) throw new Error('expected sealed keys')
      expect(result.slots.map(({ slot }) => slot.id)).toEqual([`host:opencode:${openCodeKeyEnv('anthropic')}`])
      // The export now takes a while, as a real one may.
      const bin = join(HOME, 'opencode-bin')
      writeFileSync(
        join(bin, 'opencode'),
        `#!/bin/sh\nsleep ${SLOW_EXPORT_SECONDS}\ncat '${join(bin, 'export.json')}'\n`
      )
      chmodSync(join(bin, 'opencode'), 0o755)
      const order: string[] = []
      const timer = new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push('timer')
          resolve()
        }, CONCURRENT_TIMER_MS)
      )
      const key = result.slots[0]!.read().then((value) => {
        order.push('key')
        return value
      })
      await expect(key).resolves.toBe('fixture-opencode-key')
      await timer
      expect(order).toEqual(['timer', 'key'])
    }
  )

  it('needs exactly one host for a slot', () => {
    const binding = { env: 'X_KEY', provider: 'example', defaultHost: 'api.example.test' }
    expect(hostKeySlot('opencode', { ...binding, hosts: [] })).toBeUndefined()
    expect(hostKeySlot('opencode', { ...binding, hosts: ['a.example.test', 'b.example.test'] })).toBeUndefined()
    expect(hostKeySlot('opencode', { ...binding, hosts: ['api.example.test'] })?.saas).toBe(true)
  })
})
