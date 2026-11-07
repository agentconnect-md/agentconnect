import { describe, expect, it } from 'vitest'
import { sealHostProviderKeys } from '../src/credential-proxy/host-keys.js'
import type { ProviderSlot } from '../src/credential-proxy/provider-route.js'
import {
  microsandboxCredentialStep,
  prepareAmbientCredentials,
  prepareMicrosandboxCredentials,
  type SecretBinding
} from '../src/microsandbox/secrets.js'

// github-app-git-credentials.md, Provider keys: runtimes whose API key is an env variable, behind placeholders in a VM and in srt.
const COPILOT_KEY = 'fixture-copilot-provider-key'
const GEMINI_KEY = 'fixture-gemini-api-key'
const copilot = { command: 'copilot', args: ['--acp'], env: [] }
const antigravity = { command: './agy_acp_server.par', args: [], env: [] }
const COPILOT_BASE = 'https://models.example.test/v1'

function bindings(runtimeId: string, runtime: typeof copilot, hostEnv: NodeJS.ProcessEnv, explicitEnv = {}) {
  const seen: SecretBinding[] = []
  prepareAmbientCredentials(runtimeId, runtime, hostEnv, explicitEnv, (binding) => {
    seen.push(binding)
    return `sealed-${binding.env}`
  })
  return seen
}

function seal(runtimeId: string, runtime: typeof copilot, hostEnv: NodeJS.ProcessEnv, explicitEnv = {}) {
  return sealHostProviderKeys(
    { runtimeId, runtime, hostEnv, explicitEnv, platform: 'darwin' },
    (slot: ProviderSlot) => `acph1_fixture-${slot.id}`
  )
}

describe('GitHub Copilot provider key', () => {
  it('binds COPILOT_PROVIDER_API_KEY to the base URL beside it, for the provider type it names', () => {
    const env = { COPILOT_PROVIDER_API_KEY: COPILOT_KEY, COPILOT_PROVIDER_BASE_URL: COPILOT_BASE }
    const vm = prepareMicrosandboxCredentials('github-copilot-cli', copilot, env)!
    expect(vm.secrets.map(({ env, placeholder, host }) => ({ env, placeholder, host }))).toEqual([
      {
        env: 'COPILOT_PROVIDER_API_KEY',
        placeholder: 'msb-secret-COPILOT_PROVIDER_API_KEY',
        host: ['models.example.test']
      }
    ])
    expect(bindings('github-copilot-cli', copilot, env)).toEqual([
      {
        env: 'COPILOT_PROVIDER_API_KEY',
        provider: 'openai',
        hosts: ['models.example.test'],
        defaultHost: 'api.openai.com'
      }
    ])
    expect(bindings('github-copilot-cli', copilot, env, { COPILOT_PROVIDER_TYPE: 'anthropic' })[0]).toMatchObject({
      provider: 'anthropic',
      defaultHost: 'api.anthropic.com'
    })
    expect(bindings('github-copilot-cli', copilot, env, { COPILOT_PROVIDER_TYPE: 'azure' })[0]).toEqual({
      env: 'COPILOT_PROVIDER_API_KEY',
      provider: 'azure',
      hosts: ['models.example.test']
    })
  })

  it("seals the launch env's key at its endpoint and reads it again from the env it came from", async () => {
    const hostEnv: NodeJS.ProcessEnv = { COPILOT_PROVIDER_API_KEY: COPILOT_KEY }
    const result = seal('github-copilot-cli', copilot, hostEnv, { COPILOT_PROVIDER_BASE_URL: COPILOT_BASE })
    if (!result || 'kept' in result) throw new Error('expected sealed keys')
    expect(result.slots.map(({ slot }) => slot)).toEqual([
      {
        id: 'host:github-copilot-cli:COPILOT_PROVIDER_API_KEY',
        provider: 'openai',
        host: 'models.example.test',
        port: 443,
        saas: false
      }
    ])
    hostEnv.COPILOT_PROVIDER_API_KEY = 'fixture-rotated'
    await expect(result.slots[0]!.read()).resolves.toBe('fixture-rotated')
    delete hostEnv.COPILOT_PROVIDER_API_KEY
    await expect(result.slots[0]!.read()).rejects.toThrow(/no longer holds COPILOT_PROVIDER_API_KEY/)
  })

  it('keeps a key with no HTTPS base URL, and needs no key at all', () => {
    expect(seal('github-copilot-cli', copilot, { COPILOT_PROVIDER_API_KEY: COPILOT_KEY })).toEqual({
      kept: 'COPILOT_PROVIDER_API_KEY reach no single HTTPS host the proxy recognizes'
    })
    expect(
      seal('github-copilot-cli', copilot, {
        COPILOT_PROVIDER_API_KEY: COPILOT_KEY,
        COPILOT_PROVIDER_BASE_URL: 'http://models.example.test/v1'
      })
    ).toEqual({ kept: 'COPILOT_PROVIDER_API_KEY reach no single HTTPS host the proxy recognizes' })
    expect(seal('github-copilot-cli', copilot, { COPILOT_PROVIDER_BASE_URL: COPILOT_BASE })).toBeUndefined()
  })
})

describe('Antigravity Gemini API key', () => {
  it("binds GEMINI_API_KEY to the Gemini API's own host, or to GOOGLE_GEMINI_BASE_URL", () => {
    expect(bindings('antigravity-acp', antigravity, { GEMINI_API_KEY: GEMINI_KEY })).toEqual([
      {
        env: 'GEMINI_API_KEY',
        provider: 'google',
        hosts: ['generativelanguage.googleapis.com'],
        defaultHost: 'generativelanguage.googleapis.com'
      }
    ])
    expect(
      bindings(
        'antigravity-acp',
        antigravity,
        { GEMINI_API_KEY: GEMINI_KEY },
        { GOOGLE_GEMINI_BASE_URL: 'https://gemini.example.test' }
      )[0]!.hosts
    ).toEqual(['gemini.example.test'])
    const result = seal('antigravity-acp', antigravity, { GEMINI_API_KEY: GEMINI_KEY })
    if (!result || 'kept' in result) throw new Error('expected sealed keys')
    expect(result.slots.map(({ slot }) => [slot.host, slot.saas])).toEqual([
      ['generativelanguage.googleapis.com', true]
    ])
    expect(
      seal('antigravity-acp', antigravity, { GEMINI_API_KEY: GEMINI_KEY, GOOGLE_GEMINI_BASE_URL: 'http://gemini.test' })
    ).toEqual({ kept: 'GEMINI_API_KEY reach no single HTTPS host the proxy recognizes' })
  })

  it("puts the VM's placeholder in the guest env and trusts the VM proxy", () => {
    const step = microsandboxCredentialStep('antigravity-acp', antigravity, { GEMINI_API_KEY: GEMINI_KEY })
    expect(step.protectedCredentials?.secrets.map((secret) => [secret.host, secret.readValue()])).toEqual([
      [['generativelanguage.googleapis.com'], GEMINI_KEY]
    ])
    const env: Record<string, string> = { GEMINI_API_KEY: GEMINI_KEY, COPY: GEMINI_KEY }
    step.protectEnv(env)
    expect(env).toMatchObject({
      GEMINI_API_KEY: 'msb-secret-GEMINI_API_KEY',
      COPY: 'msb-secret-GEMINI_API_KEY',
      NODE_EXTRA_CA_CERTS: '/.msb/tls/ca.pem'
    })
    expect(prepareMicrosandboxCredentials('antigravity-acp', antigravity, {})).toBeUndefined()
  })
})
