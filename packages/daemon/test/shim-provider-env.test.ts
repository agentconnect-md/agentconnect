import { describe, expect, it } from 'vitest'
import { AcpRunner, fillInCodexBaseUrl, sandboxProviderEnv, type EmitEvent } from '../src/shim/acp-runner.js'
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
async function spawnAndReadEnv(command: string, requestEnv: Record<string, string>): Promise<Record<string, string>> {
  const chunks: string[] = []
  let onExit: (() => void) | undefined
  const exited = new Promise<void>((resolve) => (onExit = resolve))
  const emit: EmitEvent = (event: ShimEvent['event']) => {
    if (event.kind === 'chunk') chunks.push(Buffer.from(event.data, 'base64').toString('utf8'))
    if (event.kind === 'exit') onExit?.()
  }
  const runner = new AcpRunner({ emit, resolveCommand: () => process.execPath, podEnv: POD_ENV })
  await runner.apply({
    op: 'open',
    command,
    args: [
      '-e',
      'process.stdout.write(JSON.stringify({A: process.env.ANTHROPIC_API_KEY ?? null, B: process.env.ANTHROPIC_BASE_URL ?? null, O: process.env.OPENAI_API_KEY ?? null, D: process.env.DEEPSEEK_API_KEY ?? null, C: process.env.CODEX_CONFIG ?? null}))'
    ],
    env: requestEnv
  })
  await exited
  return JSON.parse(chunks.join('')) as Record<string, string>
}

describe('AcpRunner provider env fill-in', () => {
  it('fills pod provider vars into a claude spawn and keeps codex vars out', async () => {
    const seen = await spawnAndReadEnv('claude-agent-acp', { PATH: process.env.PATH ?? '' })
    expect(seen).toEqual({ A: 'sk-claude-pod', B: 'https://claude-egress.internal', O: null, D: null, C: null })
  })

  it('fills the deepseek pod vars into a dsh-acp spawn', async () => {
    const seen = await spawnAndReadEnv('dsh-acp', { PATH: process.env.PATH ?? '' })
    expect(seen).toEqual({ A: null, B: null, O: null, D: 'sk-deepseek-pod', C: null })
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
  const codexProviders = (config: string) =>
    (JSON.parse(config) as { model_providers: { openai: Record<string, unknown> } }).model_providers.openai

  it('creates CODEX_CONFIG aiming the built-in openai provider at the pod URL', () => {
    const env: Record<string, string> = {}
    fillInCodexBaseUrl(env, POD_ENV)
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({
      model_provider: 'openai',
      model_providers: {
        openai: { name: 'OpenAI', base_url: 'https://codex-egress.internal', env_key: 'OPENAI_API_KEY' }
      }
    })
  })

  it('merges into a daemon-sent config, preserving unrelated fields', () => {
    const env = { CODEX_CONFIG: JSON.stringify({ features: { apps: false }, model: 'gpt-5.3-codex' }) }
    fillInCodexBaseUrl(env, POD_ENV)
    const config = JSON.parse(env.CODEX_CONFIG) as Record<string, unknown>
    expect(config.features).toEqual({ apps: false })
    expect(config.model).toBe('gpt-5.3-codex')
    expect(codexProviders(env.CODEX_CONFIG).base_url).toBe('https://codex-egress.internal')
  })

  it('leaves a daemon-aimed base_url alone', () => {
    const daemonConfig = JSON.stringify({
      model_providers: { openai: { base_url: 'https://daemon-decided.internal' } }
    })
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

describe('AcpRunner codex config projection', () => {
  it('projects the pod codex base URL into CODEX_CONFIG on a codex spawn', async () => {
    const seen = await spawnAndReadEnv('codex-acp', { PATH: process.env.PATH ?? '' })
    expect(seen.O).toBe('sk-codex-pod')
    const config = JSON.parse(seen.C!) as Record<string, unknown>
    expect(config).toMatchObject({
      model_provider: 'openai',
      model_providers: { openai: { base_url: 'https://codex-egress.internal', env_key: 'OPENAI_API_KEY' } }
    })
  })

  it('keeps a daemon-sent CODEX_CONFIG base_url authoritative over the pod value', async () => {
    const daemonConfig = JSON.stringify({
      model_providers: { openai: { base_url: 'https://daemon-decided.internal' } }
    })
    const seen = await spawnAndReadEnv('codex-acp', { PATH: process.env.PATH ?? '', CODEX_CONFIG: daemonConfig })
    expect(seen.C).toBe(daemonConfig)
  })
})
