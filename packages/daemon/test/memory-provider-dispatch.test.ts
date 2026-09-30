import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeDef } from '../src/config/config-schema.js'
import {
  createMemoryProvider,
  memoryProviderFor,
  memoryKindOf,
  MemoryProviderUnavailableError,
  type MemoryProviderKind
} from '../src/memory/provider.js'
import { MEMORY_INDEX } from '../src/memory/store.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'ac-m2-'))
}
const claude: RuntimeDef = { command: 'npx', args: ['@zed/claude-code-acp'], env: [] } as unknown as RuntimeDef
const codex: RuntimeDef = { command: 'npx', args: ['codex-acp'], env: [] } as unknown as RuntimeDef
const grok: RuntimeDef = {
  command: 'npx',
  args: ['-y', '@xai-official/grok@0.2.112', 'agent', 'stdio'],
  env: []
} as unknown as RuntimeDef
const other: RuntimeDef = { command: 'npx', args: ['gemini-acp'], env: [] } as unknown as RuntimeDef

describe('memoryProviderFor (spawn-time provider + env)', () => {
  const agent = (provider: MemoryProviderKind | undefined, runtime = 'claude') => ({
    runtime,
    ...(provider ? { memory: { provider } } : {})
  })

  it('managed+claude disables the runtime own-memory', () => {
    expect(memoryProviderFor(agent('managed'), claude).runtimeEnv()).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
  })

  it('managed+grok disables Grok cross-session memory', () => {
    expect(memoryProviderFor(agent('managed', 'grok-build'), grok).runtimeEnv()).toEqual({ GROK_MEMORY: '0' })
    // A custom runtime id still falls back to the npx package signature.
    expect(memoryProviderFor(agent('managed', 'my-grok'), grok).runtimeEnv()).toEqual({ GROK_MEMORY: '0' })
  })

  it('absent provider defaults to managed', () => {
    expect(memoryKindOf(agent(undefined))).toBe('managed')
    expect(memoryProviderFor(agent(undefined), claude).runtimeEnv()).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
  })

  // A host launch keeps the host's own runtime directories and login (#2668), and native memory must stay on.
  it('native adds neither a directory redirect nor an off-switch', () => {
    expect(memoryProviderFor(agent('native'), claude).runtimeEnv()).toEqual({})
    expect(memoryProviderFor(agent('native', 'codex'), codex).runtimeEnv()).toEqual({})
  })

  it('none disables runtime-native memory without enabling a daemon store', () => {
    expect(memoryProviderFor(agent('none'), claude).runtimeEnv()).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
    expect(
      memoryProviderFor(agent('none'), codex, { CODEX_CONFIG: '{"features":{"other":true}}' }).runtimeEnv()
    ).toEqual({
      CODEX_CONFIG: '{"features":{"other":true,"memories":false}}'
    })
    expect(memoryProviderFor(agent('none', 'grok-build'), grok).runtimeEnv()).toEqual({ GROK_MEMORY: '0' })
    expect(memoryProviderFor(agent('none', 'my-grok'), grok).runtimeEnv()).toEqual({ GROK_MEMORY: '0' })
    expect(() => memoryProviderFor(agent('none'), other).runtimeEnv()).toThrow(MemoryProviderUnavailableError)
  })

  it.each([
    ['opencode', 'custom-wrapper', ['serve-acp']],
    ['my-opencode', './opencode', ['acp']],
    ['my-opencode', 'C:\\Tools\\opencode.exe', ['acp']],
    ['my-opencode', 'npx', ['-y', 'opencode-ai@1.18.32', 'acp']]
  ])('allows none memory for %s via %s without replacing provider config', (runtimeId, command, args) => {
    const runtime = { command, args, env: [] } as unknown as RuntimeDef
    const env = {
      OPENCODE_CONFIG_CONTENT: '{"enabled_providers":["deepseek"],"model":"deepseek/deepseek-chat"}',
      DEEPSEEK_API_KEY: 'test-provider-key'
    }
    const before = { ...env }
    expect(memoryProviderFor(agent('none', runtimeId), runtime, env).runtimeEnv()).toEqual({})
    expect(env).toEqual(before)
  })

  it('keeps invalid runtime config on the provider-unavailable error surface', () => {
    expect(() => memoryProviderFor(agent('none'), codex, { CODEX_CONFIG: 'not-json' }).runtimeEnv()).toThrow(
      MemoryProviderUnavailableError
    )
  })

  it('native on an unregistered runtime throws (env unverified)', () => {
    expect(() => memoryProviderFor(agent('native'), other).runtimeEnv()).toThrow(MemoryProviderUnavailableError)
  })

  it('external fails closed without a connection id/verified registry admission', () => {
    expect(() => memoryProviderFor(agent('external'), claude).runtimeEnv()).toThrow(MemoryProviderUnavailableError)
    const external = {
      ...agent('external'),
      memory: { provider: 'external' as const, connectionId: '11111111-1111-4111-8111-111111111111' }
    }
    expect(() => memoryProviderFor(external, claude).runtimeEnv()).toThrow('registry is not available')
    expect(memoryProviderFor(external, claude, {}, { assertReady: () => undefined }).runtimeEnv()).toEqual({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
    })
    expect(() => memoryProviderFor(external, other, {}, { assertReady: () => undefined }).runtimeEnv()).toThrow(
      'off-switch unverified'
    )
    expect(() =>
      memoryProviderFor(
        external,
        claude,
        {},
        {
          assertReady: () => {
            throw new Error('connection invalid')
          }
        }
      ).runtimeEnv()
    ).toThrow('connection invalid')
  })
})

describe('DispatchingMemoryProvider (per-agent routing)', () => {
  // Three agents: managed, native, and explicitly memoryless.
  const roots: Record<string, string> = {}
  const kinds: Record<string, MemoryProviderKind> = { 'bot-m': 'managed', 'bot-n': 'native', 'bot-0': 'none' }
  function provider() {
    return createMemoryProvider({
      memoryHomePortsFor: (id) =>
        roots[id] === undefined ? undefined : localMemoryHome(new LocalMemoryFs(roots[id]!)),
      providerKindFor: (id) => kinds[id] ?? 'managed'
    })
  }

  it('managed agent: tools present, list/write hit our <root>/memory dir, index injects', async () => {
    roots['bot-m'] = newDir()
    const p = provider()
    expect(p.toolsForAgent('bot-m').map((t) => t.name)).toContain('writeMemory')
    await p.ensure({ agentId: 'bot-m' }, 'bot-m')
    await p.write({ agentId: 'bot-m' }, MEMORY_INDEX, '# idx')
    expect((await p.list({ agentId: 'bot-m' })).map((f) => f.name)).toContain(MEMORY_INDEX)
    expect(await p.standingContextAtSessionStart({ agentId: 'bot-m' })).toContain('# idx')
    await expect(
      p.recallForTurn({ agentId: 'bot-m' }, { turnId: 'turn-1', query: 'q', topK: 5, maxBytes: 8192, timeoutMs: 1000 })
    ).resolves.toEqual([])
    expect(p.adminSurfaceForAgent('bot-m')?.shape).toBe('files')
  })

  it('native agent: no tools, injection, or console surface', async () => {
    const p = provider()
    const scope = { agentId: 'bot-n' }
    expect(p.toolsForAgent('bot-n')).toEqual([])
    await p.ensure(scope, 'bot-n')
    expect(await p.standingContextAtSessionStart(scope)).toBe('')
    expect(p.adminSurfaceForAgent('bot-n')).toBeNull()
    expect(await p.list(scope)).toEqual([])
    await expect(p.read(scope, MEMORY_INDEX)).rejects.toThrow('native memory is not exposed')
    await expect(p.write(scope, MEMORY_INDEX, '# nope')).rejects.toThrow('native memory is not exposed')
  })

  it('none: no tools, store, injection, or writes', async () => {
    const p = provider()
    const scope = { agentId: 'bot-0' }
    expect(p.toolsForAgent('bot-0')).toEqual([])
    await p.ensure(scope, 'bot-0')
    expect(await p.standingContextAtSessionStart(scope)).toBe('')
    expect(p.adminSurfaceForAgent('bot-0')).toBeNull()
    expect(await p.list(scope)).toEqual([])
    await expect(p.read(scope, MEMORY_INDEX)).rejects.toThrow('persistent memory is disabled')
    await expect(p.write(scope, MEMORY_INDEX, '# nope')).rejects.toThrow('persistent memory is disabled')
  })
})
