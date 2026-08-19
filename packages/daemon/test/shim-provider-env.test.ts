import { describe, expect, it } from 'vitest'
import {
  AcpRunner,
  fillInCodexBaseUrl,
  fillInCodexConfigFloor,
  sandboxProviderEnv,
  type EmitEvent
} from '../src/shim/acp-runner.js'
import type { ShimEvent } from '../src/shim/protocol.js'

const POD_ENV = {
  AC_CLAUDE_BASE_URL: 'https://claude-egress.internal',
  AC_CLAUDE_API_KEY: 'sk-claude-pod',
  AC_CODEX_BASE_URL: 'https://codex-egress.internal',
  AC_CODEX_API_KEY: 'sk-codex-pod',
  AC_DEEPSEEK_BASE_URL: 'https://deepseek-egress.internal',
  AC_DEEPSEEK_API_KEY: 'sk-deepseek-pod'
}

describe('sandboxProviderEnv', () => {
  it('maps only the claude pod vars for a claude runtime command', () => {
    expect(sandboxProviderEnv('claude-agent-acp', POD_ENV)).toEqual({
      ANTHROPIC_BASE_URL: 'https://claude-egress.internal',
      ANTHROPIC_API_KEY: 'sk-claude-pod'
    })
  })

  it('maps only the codex pod vars for a codex runtime command, including path-qualified', () => {
    expect(sandboxProviderEnv('/usr/local/bin/codex-acp', POD_ENV)).toEqual({
      OPENAI_BASE_URL: 'https://codex-egress.internal',
      OPENAI_API_KEY: 'sk-codex-pod'
    })
  })

  it('maps only the deepseek pod vars for the harness command the image installs', () => {
    expect(sandboxProviderEnv('dsh-acp', POD_ENV)).toEqual({
      DEEPSEEK_BASE_URL: 'https://deepseek-egress.internal',
      DEEPSEEK_API_KEY: 'sk-deepseek-pod'
    })
  })

  it('gives an unrecognized runtime nothing — no vendor sees another vendor key', () => {
    expect(sandboxProviderEnv('zeroclaw', POD_ENV)).toEqual({})
    expect(sandboxProviderEnv('hermes', POD_ENV)).toEqual({})
  })

  it('skips empty or whitespace pod values instead of injecting blanks', () => {
    expect(sandboxProviderEnv('claude-agent-acp', { AC_CLAUDE_API_KEY: '  ', AC_CLAUDE_BASE_URL: '' })).toEqual({})
  })
})

// Spawn through the real runner: resolveCommand maps the registry command to node so the
// child can print the environment it actually received.
async function spawnAndReadEnv(
  command: string,
  requestEnv: Record<string, string>,
  podEnv: Record<string, string | undefined> = POD_ENV
): Promise<Record<string, string>> {
  const chunks: string[] = []
  let onExit: (() => void) | undefined
  const exited = new Promise<void>((resolve) => (onExit = resolve))
  const emit: EmitEvent = (event: ShimEvent['event']) => {
    if (event.kind === 'chunk') chunks.push(Buffer.from(event.data, 'base64').toString('utf8'))
    if (event.kind === 'exit') onExit?.()
  }
  const runner = new AcpRunner({ emit, resolveCommand: () => process.execPath, podEnv })
  await runner.apply({
    op: 'open',
    command,
    args: [
      '-e',
      'process.stdout.write(JSON.stringify({A: process.env.ANTHROPIC_API_KEY ?? null, B: process.env.ANTHROPIC_BASE_URL ?? null, O: process.env.OPENAI_API_KEY ?? null, D: process.env.DEEPSEEK_API_KEY ?? null, C: process.env.CODEX_CONFIG ?? null, R: process.env.DEFAULT_AUTH_REQUEST ?? null}))'
    ],
    env: requestEnv
  })
  await exited
  return JSON.parse(chunks.join('')) as Record<string, string>
}

describe('AcpRunner provider env fill-in', () => {
  it('fills pod provider vars into a claude spawn and keeps codex vars out', async () => {
    const seen = await spawnAndReadEnv('claude-agent-acp', { PATH: process.env.PATH ?? '' })
    expect(seen).toEqual({
      A: 'sk-claude-pod',
      B: 'https://claude-egress.internal',
      O: null,
      D: null,
      C: null,
      R: null
    })
  })

  it('fills the deepseek pod vars into a dsh-acp spawn', async () => {
    const seen = await spawnAndReadEnv('dsh-acp', { PATH: process.env.PATH ?? '' })
    expect(seen).toEqual({ A: null, B: null, O: null, D: 'sk-deepseek-pod', C: null, R: null })
  })

  it('pairs a codex key with a gateway auth request, and lets a daemon-sent one win', async () => {
    const filled = await spawnAndReadEnv('codex-acp', { PATH: process.env.PATH ?? '' })
    expect(filled.O).toBe('sk-codex-pod')
    // Without this a fresh CODEX_HOME answers every session with -32000 — and the gateway method
    // keeps the grant process-ephemeral, so an injected key never becomes a shared account.
    expect(JSON.parse(filled.R!)._meta.gateway).toEqual({
      baseUrl: 'https://codex-egress.internal',
      headers: { Authorization: 'Bearer sk-codex-pod' },
      providerName: 'AgentConnect model egress'
    })
    const daemonSent = await spawnAndReadEnv('codex-acp', {
      PATH: process.env.PATH ?? '',
      DEFAULT_AUTH_REQUEST: '{"methodId":"chat-gpt"}'
    })
    expect(daemonSent.R).toBe('{"methodId":"chat-gpt"}')
  })

  it('falls to the runtime default endpoint only when the pod floor carries no base either', async () => {
    // A daemon-injected key with no daemon URL and no pod URL: the endpoint-less shape bottoms
    // out at the injection precedence's last layer, still as a process-ephemeral gateway grant.
    const seen = await spawnAndReadEnv(
      'codex-acp',
      { PATH: process.env.PATH ?? '', OPENAI_API_KEY: 'sk-issued' },
      { AC_CODEX_API_KEY: 'sk-pod-unused' }
    )
    expect(seen.O).toBe('sk-issued')
    expect(JSON.parse(seen.R!)._meta.gateway).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      headers: { Authorization: 'Bearer sk-issued' },
      providerName: 'AgentConnect model egress'
    })
  })

  it('routes a daemon-injected key by the pod base-URL floor when the daemon named no endpoint', async () => {
    // The reported cloud shape: issued key, base URL present only in the live pod. The request
    // must aim at the pod's gateway — composing the public endpoint here would send the issued
    // key straight past the floor.
    const seen = await spawnAndReadEnv('codex-acp', { PATH: process.env.PATH ?? '', OPENAI_API_KEY: 'sk-issued' })
    expect(seen.O).toBe('sk-issued')
    expect(JSON.parse(seen.R!)._meta.gateway).toEqual({
      baseUrl: 'https://codex-egress.internal',
      headers: { Authorization: 'Bearer sk-issued' },
      providerName: 'AgentConnect model egress'
    })
  })

  it('lets a daemon-sent value win over the pod value', async () => {
    const seen = await spawnAndReadEnv('claude-agent-acp', {
      PATH: process.env.PATH ?? '',
      ANTHROPIC_API_KEY: 'sk-from-daemon'
    })
    expect(seen.A).toBe('sk-from-daemon')
    expect(seen.B).toBe('https://claude-egress.internal')
  })
})

describe('fillInCodexBaseUrl', () => {
  it('creates CODEX_CONFIG aiming the built-in openai provider at the pod URL', () => {
    const env: Record<string, string> = {}
    fillInCodexBaseUrl(env, POD_ENV)
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({
      model_provider: 'openai',
      openai_base_url: 'https://codex-egress.internal'
    })
  })

  it('merges into a daemon-sent config, preserving unrelated fields', () => {
    const env = { CODEX_CONFIG: JSON.stringify({ features: { apps: false }, model: 'gpt-5.3-codex' }) }
    fillInCodexBaseUrl(env, POD_ENV)
    const config = JSON.parse(env.CODEX_CONFIG) as Record<string, unknown>
    expect(config.features).toEqual({ apps: false })
    expect(config.model).toBe('gpt-5.3-codex')
    expect(config.openai_base_url).toBe('https://codex-egress.internal')
  })

  it('leaves a daemon-aimed openai_base_url alone', () => {
    const daemonConfig = JSON.stringify({ openai_base_url: 'https://daemon-decided.internal' })
    const env = { CODEX_CONFIG: daemonConfig }
    fillInCodexBaseUrl(env, POD_ENV)
    expect(env.CODEX_CONFIG).toBe(daemonConfig)
  })

  it('leaves a config that selects a different model provider alone', () => {
    const daemonConfig = JSON.stringify({ model_provider: 'custom-gateway' })
    const env = { CODEX_CONFIG: daemonConfig }
    fillInCodexBaseUrl(env, POD_ENV)
    expect(env.CODEX_CONFIG).toBe(daemonConfig)
  })

  it('warns and leaves a malformed config untouched instead of throwing', () => {
    const env = { CODEX_CONFIG: 'not json' }
    const warnings: string[] = []
    fillInCodexBaseUrl(env, POD_ENV, (message) => warnings.push(message))
    expect(env.CODEX_CONFIG).toBe('not json')
    expect(warnings).toHaveLength(1)
  })

  it('does nothing without a pod base URL', () => {
    const env: Record<string, string> = {}
    fillInCodexBaseUrl(env, { AC_CODEX_BASE_URL: '  ' })
    expect(env.CODEX_CONFIG).toBeUndefined()
  })
})

describe('fillInCodexConfigFloor', () => {
  const FLOOR_ENV = { AC_CODEX_CONFIG: JSON.stringify({ features: { multi_agent: false } }) }

  it('creates CODEX_CONFIG from the pod floor alone', () => {
    const env: Record<string, string> = {}
    fillInCodexConfigFloor(env, FLOOR_ENV)
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({ features: { multi_agent: false } })
  })

  it('merges a shared table one level deep — the daemon features never evict the floor entries', () => {
    // The daemon's default codex launch always sends `features` (account apps off), so a
    // whole-table replacement would silently drop the floor. Regression: this exact pair once
    // produced only `{"features":{"apps":false}}`.
    const env = { CODEX_CONFIG: JSON.stringify({ features: { apps: false }, model: 'gpt-5.3-codex' }) }
    fillInCodexConfigFloor(env, FLOOR_ENV)
    const config = JSON.parse(env.CODEX_CONFIG) as Record<string, unknown>
    expect(config.features).toEqual({ apps: false, multi_agent: false })
    expect(config.model).toBe('gpt-5.3-codex')
  })

  it('keeps a daemon-sent leaf authoritative over the same floor leaf', () => {
    const env = { CODEX_CONFIG: JSON.stringify({ features: { multi_agent: true } }) }
    fillInCodexConfigFloor(env, FLOOR_ENV)
    expect(JSON.parse(env.CODEX_CONFIG)).toEqual({ features: { multi_agent: true } })
  })

  it('lets a daemon non-table value replace a floor table outright', () => {
    const env = { CODEX_CONFIG: JSON.stringify({ features: 'inherit' }) }
    fillInCodexConfigFloor(env, FLOOR_ENV)
    expect(JSON.parse(env.CODEX_CONFIG)).toEqual({ features: 'inherit' })
  })

  it('composes with the base-url fill-in: floor config never blocks the pod aim', () => {
    const env: Record<string, string> = {}
    fillInCodexConfigFloor(env, { ...POD_ENV, ...FLOOR_ENV })
    fillInCodexBaseUrl(env, { ...POD_ENV, ...FLOOR_ENV })
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({
      features: { multi_agent: false },
      model_provider: 'openai',
      openai_base_url: 'https://codex-egress.internal'
    })
  })

  it('warns and leaves a malformed floor unapplied instead of throwing', () => {
    const env: Record<string, string> = {}
    const warnings: string[] = []
    fillInCodexConfigFloor(env, { AC_CODEX_CONFIG: 'not json' }, (message) => warnings.push(message))
    expect(env.CODEX_CONFIG).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('warns and leaves a malformed daemon config untouched instead of throwing', () => {
    const env = { CODEX_CONFIG: 'not json' }
    const warnings: string[] = []
    fillInCodexConfigFloor(env, FLOOR_ENV, (message) => warnings.push(message))
    expect(env.CODEX_CONFIG).toBe('not json')
    expect(warnings).toHaveLength(1)
  })

  it('does nothing on an absent, blank, or empty-object floor', () => {
    for (const value of [undefined, '  ', '{}']) {
      const env: Record<string, string> = {}
      fillInCodexConfigFloor(env, { AC_CODEX_CONFIG: value })
      expect(env.CODEX_CONFIG).toBeUndefined()
    }
  })
})

describe('AcpRunner codex config projection', () => {
  it('projects the pod codex base URL into CODEX_CONFIG on a codex spawn', async () => {
    const seen = await spawnAndReadEnv('codex-acp', { PATH: process.env.PATH ?? '' })
    expect(seen.O).toBe('sk-codex-pod')
    const config = JSON.parse(seen.C!) as Record<string, unknown>
    expect(config).toMatchObject({
      model_provider: 'openai',
      openai_base_url: 'https://codex-egress.internal'
    })
  })

  it('keeps a daemon-sent CODEX_CONFIG base URL authoritative over the pod value', async () => {
    const daemonConfig = JSON.stringify({ openai_base_url: 'https://daemon-decided.internal' })
    const seen = await spawnAndReadEnv('codex-acp', { PATH: process.env.PATH ?? '', CODEX_CONFIG: daemonConfig })
    expect(seen.C).toBe(daemonConfig)
  })

  it('merges the pod config floor under the daemon aim on a codex spawn', async () => {
    const chunks: string[] = []
    let onExit: (() => void) | undefined
    const exited = new Promise<void>((resolve) => (onExit = resolve))
    const emit: EmitEvent = (event: ShimEvent['event']) => {
      if (event.kind === 'chunk') chunks.push(Buffer.from(event.data, 'base64').toString('utf8'))
      if (event.kind === 'exit') onExit?.()
    }
    const podEnv = { ...POD_ENV, AC_CODEX_CONFIG: JSON.stringify({ features: { multi_agent: false } }) }
    const runner = new AcpRunner({ emit, resolveCommand: () => process.execPath, podEnv })
    await runner.apply({
      op: 'open',
      command: 'codex-acp',
      args: ['-e', 'process.stdout.write(process.env.CODEX_CONFIG ?? "")'],
      env: {
        PATH: process.env.PATH ?? '',
        // The default launch shape: the daemon aims codex and disables account apps.
        CODEX_CONFIG: JSON.stringify({ features: { apps: false }, openai_base_url: 'https://daemon-decided.internal' })
      }
    })
    await exited
    expect(JSON.parse(chunks.join(''))).toEqual({
      features: { apps: false, multi_agent: false },
      openai_base_url: 'https://daemon-decided.internal'
    })
  })
})
