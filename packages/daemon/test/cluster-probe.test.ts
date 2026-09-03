import { describe, expect, it } from 'vitest'
import {
  PROBE_PLACEHOLDER_KEY,
  clusterProbeEnv,
  parseK8sProbePayload,
  poolProbeKey,
  probeClusterRuntimes
} from '../src/runtimes/cluster-probe.js'
import type { RuntimeDef } from '../src/config/config-schema.js'

/** The `--k8s` credentialed model probe: what a probed runtime launches with, and how the sweep
 *  behaves when one of them refuses. */

const claude: RuntimeDef = { command: 'claude-agent-acp', args: [], env: [] }
const codex: RuntimeDef = { command: 'codex-acp', args: [], env: [] }
const unknown: RuntimeDef = { command: 'some-acp-agent', args: [], env: [] }

describe('cluster runtime probe', () => {
  it('launches with the deployment’s provider pair and the identity that routes it into the pod', () => {
    const { env } = clusterProbeEnv('claude-acp', claude, {
      agentId: 'ac-runtime-probe-abc',
      staticCredential: (kind) => (kind === 'claude' ? { key: 'token', baseUrl: 'https://gw.example' } : undefined)
    })
    expect(env).toEqual({
      AC_AGENT_ID: 'ac-runtime-probe-abc',
      ANTHROPIC_API_KEY: 'token',
      ANTHROPIC_BASE_URL: 'https://gw.example'
    })
  })

  it('carries nothing but the routing id for a runtime with no configured provider surface', () => {
    // The pod's own `AC_*` fill-in is the other credential source, and it belongs to the shim.
    // Inventing an env here would state something about a machine this daemon is not on.
    expect(clusterProbeEnv('mystery', unknown, { agentId: 'probe' })).toEqual({
      env: { AC_AGENT_ID: 'probe' },
      redactValues: [],
      // Nothing was withheld from a runtime that carries its own auth, so a refusal from one is
      // live knowledge about its login rather than a gap in this launch.
      uncredentialed: false
    })
  })

  it('admits the enumeration session with a stand-in key when the deployment’s pair is endpoint-only', () => {
    // The key-server shape: real launches mint a per-session key and a probe belongs to no
    // session, so codex refused `session/new` outright and the whole model list was lost.
    const { env, redactValues, uncredentialed } = clusterProbeEnv('codex-acp', codex, {
      agentId: 'probe',
      staticCredential: () => ({ key: '', baseUrl: 'https://gw.example/v1' })
    })
    expect(env.OPENAI_API_KEY).toBe(PROBE_PLACEHOLDER_KEY)
    const request = JSON.parse(env.DEFAULT_AUTH_REQUEST!)
    expect(request.methodId).toBe('gateway')
    expect(request._meta.gateway.baseUrl).toBe('https://gw.example/v1')
    // A key nobody issued is not a secret, and the probe never spends it on a request.
    expect(redactValues).toEqual([])
    expect(uncredentialed).toBe(false)
  })

  it('marks a runtime the deployment configures nothing for, so its refusal is not read as a login', () => {
    const { env, uncredentialed } = clusterProbeEnv('codex-acp', codex, { agentId: 'probe' })
    expect(env).toEqual({ AC_AGENT_ID: 'probe' })
    expect(uncredentialed).toBe(true)
  })

  it('applies the codex session floor last, so a daemon-authored key stays authoritative', () => {
    const { env, redactValues } = clusterProbeEnv('codex-acp', codex, {
      agentId: 'probe',
      staticCredential: () => ({ key: 'k', baseUrl: 'https://gw.example/v1' }),
      codexSessionFloor: JSON.stringify({ model_reasoning_summary_format: 'experimental' })
    })
    const config = JSON.parse(env.CODEX_CONFIG!)
    expect(config.model_reasoning_summary_format).toBe('experimental')
    expect(env.OPENAI_API_KEY).toBe('k')
    // A probe failure must not be able to quote the key back — codex folds it into a whole blob,
    // and a cluster probe's diagnostics are published into the pool's shared store.
    expect(redactValues).toContain('k')
    expect(redactValues).toContain(env.DEFAULT_AUTH_REQUEST)
  })

  it('probes claude with the deployment’s alias declarations, so the picker it reads is the one sessions get', () => {
    const aliases = {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1',
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Fable'
    }
    const { env } = clusterProbeEnv('claude-acp', claude, {
      agentId: 'probe',
      staticCredential: () => ({ key: 'k', baseUrl: 'https://gw.example' }),
      claudeModelAliases: aliases
    })
    expect(env).toMatchObject(aliases)
    // A codex probe is told nothing about Claude's aliases.
    expect(clusterProbeEnv('codex-acp', codex, { agentId: 'probe', claudeModelAliases: aliases }).env).toEqual({
      AC_AGENT_ID: 'probe'
    })
  })

  it('reports every runtime as it answers, and one refusal does not end the sweep', async () => {
    const reported: Array<{ runtime: string; ok: boolean; models: string[] }> = []
    const results = await probeClusterRuntimes({
      runtimes: { 'claude-acp': claude, 'codex-acp': codex },
      agentId: 'probe',
      cwd: '/agent',
      timeoutMs: 5_000,
      hostFactory: (_rt, id) =>
        ({
          start: async () => {
            // An unauthenticated runtime is installed-but-logged-out, not a broken sweep.
            if (id === 'codex-acp') throw Object.assign(new Error('Authentication required'), { code: -32000 })
          },
          newSession: async () => 'session',
          modelOptions: () => ({ models: ['sonnet'], current: 'sonnet' }),
          acpProtocolVersion: () => 1,
          stop: async () => {}
        }) as never,
      onResult: (result) => {
        reported.push({ runtime: result.runtime, ok: result.ok, models: result.models })
      }
    })
    expect(reported).toEqual([
      { runtime: 'claude-acp', ok: true, models: ['sonnet'] },
      { runtime: 'codex-acp', ok: false, models: [] }
    ])
    expect(results.find((r) => r.runtime === 'codex-acp')?.authRequired).toBe(true)
    // This sweep configured no pair at all, so the mark rides the published result — an adopting
    // member reads it and has no other way to know what the prober launched with.
    expect(results.every((r) => r.uncredentialed)).toBe(true)
  })
})

describe('published probe payload', () => {
  it('round-trips a table and its results, config options verbatim', () => {
    const payload = {
      table: { runtimes: [{ id: 'claude-acp', version: '0.66.0', command: 'claude-agent-acp' }] },
      results: [
        {
          runtime: 'claude-acp',
          ok: true,
          models: ['sonnet'],
          currentModel: 'sonnet',
          acpProtocolVersion: 1,
          configOptions: [{ id: 'model', category: 'model', options: [{ value: 'sonnet' }] }]
        }
      ]
    }
    const parsed = parseK8sProbePayload(JSON.stringify(payload))
    expect(parsed?.table.runtimes[0]?.command).toBe('claude-agent-acp')
    expect(parsed?.results[0]?.configOptions).toEqual(payload.results[0]!.configOptions)
  })

  it('refuses a payload it cannot read, so the member probes rather than advertises a guess', () => {
    expect(parseK8sProbePayload('not json')).toBeUndefined()
    expect(parseK8sProbePayload('{"table":{"runtimes":[]},"results":[]}')).toBeUndefined()
    expect(parseK8sProbePayload('{"results":[]}')).toBeUndefined()
  })
})

describe('pool probe key', () => {
  const image = 'ghcr.io/agentconnect-md/runtime-sandbox:latest'

  it('is the bare image when the deployment declares nothing', () => {
    expect(poolProbeKey(image, {})).toBe(image)
    expect(poolProbeKey(image, { AC_CODEX_CONFIG: undefined })).toBe(image)
  })

  it('changes with the declarations, so a rollout that moves env and not the tag re-probes', () => {
    const before = poolProbeKey(image, { ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5' })
    const after = poolProbeKey(image, { ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1' })
    expect(before).not.toBe(after)
    expect(before).not.toBe(image)
    // The declaration is hashed, never spelled out: this key lands in the shared store and the logs.
    expect(before).toMatch(new RegExp(`^${image}#[0-9a-f]{12}$`))
    expect(before).not.toContain('claude-fable-5')
  })

  it('is stable across key order and distinguishes one declaration from two', () => {
    const a = { ANTHROPIC_DEFAULT_FABLE_MODEL: 'm', AC_CODEX_CONFIG: '{}' }
    const b = { AC_CODEX_CONFIG: '{}', ANTHROPIC_DEFAULT_FABLE_MODEL: 'm' }
    expect(poolProbeKey(image, a)).toBe(poolProbeKey(image, b))
    expect(poolProbeKey(image, a)).not.toBe(poolProbeKey(image, { ANTHROPIC_DEFAULT_FABLE_MODEL: 'm' }))
  })
})
