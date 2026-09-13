import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { readOnlyExtractionMode } from '../src/memory/distill.js'
import {
  applyOpenCodeReadOnlyMode,
  OPENCODE_READ_ONLY_MODE,
  OPENCODE_READ_ONLY_PERMISSION
} from '../src/runtime-defs/opencode-runtime.js'

const opencode = { runtime: 'opencode' as const }

describe('applyOpenCodeReadOnlyMode', () => {
  it('authors a primary read-only agent whose ACP mode the extraction gate prefers over plan', () => {
    const env: Record<string, string> = {}
    applyOpenCodeReadOnlyMode(opencode, env)
    const agent = JSON.parse(env.OPENCODE_CONFIG_CONTENT!).agent[OPENCODE_READ_ONLY_MODE]
    expect(agent.mode).toBe('primary')
    expect(agent.permission).toEqual(OPENCODE_READ_ONLY_PERMISSION)
    // OpenCode advertises every visible primary agent as a mode; the gate's own preference then selects it.
    expect(readOnlyExtractionMode(['build', 'plan', OPENCODE_READ_ONLY_MODE])).toBe(OPENCODE_READ_ONLY_MODE)
  })

  it('is an allow-list: deny first, then reads and the daemon bridge tools (key order is precedence)', () => {
    const keys = Object.keys(OPENCODE_READ_ONLY_PERMISSION)
    expect(keys[0]).toBe('*')
    expect(OPENCODE_READ_ONLY_PERMISSION['*']).toBe('deny')
    expect(keys.slice(1)).toEqual(['read', 'glob', 'grep', 'list', 'agentconnect_*'])
    for (const key of keys.slice(1))
      expect(OPENCODE_READ_ONLY_PERMISSION[key as keyof typeof OPENCODE_READ_ONLY_PERMISSION]).toBe('allow')
    // Nothing native and mutating is ever re-allowed.
    expect(keys).not.toContain('bash')
    expect(keys).not.toContain('edit')
    expect(keys).not.toContain('webfetch')
  })

  it('preserves the provider config already in OPENCODE_CONFIG_CONTENT and other agents, replacing a same-named one', () => {
    const env: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { openai: { options: { apiKey: '{env:MODEL_TOKEN}', baseURL: 'https://api.example.test/v1' } } },
        agent: { reviewer: { mode: 'subagent' }, [OPENCODE_READ_ONLY_MODE]: { permission: { bash: 'allow' } } }
      }),
      MODEL_TOKEN: 'token'
    }
    applyOpenCodeReadOnlyMode(opencode, env)
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
    expect(config.provider.openai.options).toEqual({
      apiKey: '{env:MODEL_TOKEN}',
      baseURL: 'https://api.example.test/v1'
    })
    expect(config.agent.reviewer).toEqual({ mode: 'subagent' })
    expect(config.agent[OPENCODE_READ_ONLY_MODE].permission).toEqual(OPENCODE_READ_ONLY_PERMISSION)
    expect(env.MODEL_TOKEN).toBe('token')
  })

  it('overlays the inherited daemon config when the launch sets none, and lets an explicit entry win over it', () => {
    const inherited = JSON.stringify({ provider: { custom: { options: { baseURL: 'https://llm.example.test/v1' } } } })
    const env: Record<string, string> = {}
    applyOpenCodeReadOnlyMode(opencode, env, inherited)
    const overlaid = JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
    expect(overlaid.provider.custom.options.baseURL).toBe('https://llm.example.test/v1')
    expect(overlaid.agent[OPENCODE_READ_ONLY_MODE].mode).toBe('primary')

    const explicit: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: '{env:MODEL_TOKEN}' } } } })
    }
    applyOpenCodeReadOnlyMode(opencode, explicit, inherited)
    const config = JSON.parse(explicit.OPENCODE_CONFIG_CONTENT!)
    expect(config.provider).toEqual({ openai: { options: { apiKey: '{env:MODEL_TOKEN}' } } })
    expect(config.agent[OPENCODE_READ_ONLY_MODE].permission).toEqual(OPENCODE_READ_ONLY_PERMISSION)
  })

  it('leaves every other runtime alone', () => {
    for (const target of [undefined, { runtime: 'claude' as const }, { runtime: 'codex' as const }]) {
      const env: Record<string, string> = { KEEP: '1' }
      applyOpenCodeReadOnlyMode(target, env)
      expect(env).toEqual({ KEEP: '1' })
    }
  })

  it('refuses a malformed OPENCODE_CONFIG_CONTENT rather than silently replacing it', () => {
    const env: Record<string, string> = { OPENCODE_CONFIG_CONTENT: '[not an object]' }
    expect(() => applyOpenCodeReadOnlyMode(opencode, env)).toThrow(/OPENCODE_CONFIG_CONTENT/)
  })
})

describe('dream host launch (daemon)', () => {
  function scaffold(runtime: string): string {
    const root = mkdtempSync(join(tmpdir(), 'ac-opencode-dream-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { [runtime]: { command: 'node', args: ['unused'], env: [{ name: 'RUNTIME_VALUE', value: 'r' }] } }
      })
    )
    const adir = join(root, 'agents', 'bot-a')
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: 'bot-a',
        name: 'bot-a',
        runtime,
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        memory: { provider: 'managed' }
      })
    )
    return root
  }

  async function launchEnv(runtime: string, excludeAgentToolCredentials: boolean): Promise<Record<string, string>> {
    const root = scaffold(runtime)
    const daemon = new Daemon({ root, probeRuntimes: async () => [] })
    try {
      await daemon.start()
      const inner = daemon as any
      const agent = inner.agents.get('bot-a')
      return inner.buildAcpHost(agent, inner.cfg, {
        hostKey: agentHostKey(agent.id),
        runInSandbox: false,
        cwd: join(root, 'in'),
        excludeAgentToolCredentials
      }).host.opts.env
    } finally {
      await daemon.stop()
    }
  }

  it('authors the read-only agent on an OpenCode dream host only, keeping the runtime env', async () => {
    const dream = await launchEnv('opencode', true)
    expect(JSON.parse(dream.OPENCODE_CONFIG_CONTENT!).agent[OPENCODE_READ_ONLY_MODE].permission).toEqual(
      OPENCODE_READ_ONLY_PERMISSION
    )
    expect(dream.RUNTIME_VALUE).toBe('r')
    // The warm host is untouched: its mode list stays the runtime's own, and the console never sees the agent.
    expect((await launchEnv('opencode', false)).OPENCODE_CONFIG_CONTENT).toBeUndefined()
    expect((await launchEnv('claude', true)).OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it('keeps the providers a self-hosted daemon supplies through its own OPENCODE_CONFIG_CONTENT', async () => {
    // An unsandboxed launch inherits the daemon environment beneath the explicit env; the overlay must not shadow it.
    vi.stubEnv(
      'OPENCODE_CONFIG_CONTENT',
      JSON.stringify({ provider: { custom: { options: { baseURL: 'https://llm.example.test/v1' } } } })
    )
    try {
      const config = JSON.parse((await launchEnv('opencode', true)).OPENCODE_CONFIG_CONTENT!)
      expect(config.provider.custom.options.baseURL).toBe('https://llm.example.test/v1')
      expect(config.agent[OPENCODE_READ_ONLY_MODE].permission).toEqual(OPENCODE_READ_ONLY_PERMISSION)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
