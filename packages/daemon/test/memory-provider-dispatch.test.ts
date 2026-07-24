import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeDef } from '../src/config/config-schema.js'
import {
  createMemoryProvider,
  memoryProviderFor,
  memoryKindOf,
  MemoryProviderUnavailableError,
  type MemoryProviderKind
} from '../src/agents/memory-provider.js'
import { MEMORY_INDEX, MemoryConflictError } from '../src/agents/memory.js'
import { isNativeRuntimeSupported, nativeRuntimeEnv } from '../src/agents/native-memory.js'

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'ac-m2-'))
}
const claude: RuntimeDef = { command: 'npx', args: ['@zed/claude-code-acp'], env: [] } as unknown as RuntimeDef
const codex: RuntimeDef = { command: 'npx', args: ['codex-acp'], env: [] } as unknown as RuntimeDef
const grok: RuntimeDef = {
  command: 'npx',
  args: ['-y', '@xai-official/grok@0.2.101', 'agent', 'stdio'],
  env: []
} as unknown as RuntimeDef
const other: RuntimeDef = { command: 'npx', args: ['gemini-acp'], env: [] } as unknown as RuntimeDef

describe('native-memory: runtime env levers', () => {
  it('claude → CLAUDE_CONFIG_DIR under the agent root; no disable flag', () => {
    expect(isNativeRuntimeSupported(claude)).toBe(true)
    const env = nativeRuntimeEnv(claude, '/agents/bot-a')
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: join('/agents/bot-a', '.claude') })
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined()
  })

  it('codex → CODEX_HOME under the agent root', () => {
    expect(isNativeRuntimeSupported(codex)).toBe(true)
    expect(nativeRuntimeEnv(codex, '/agents/bot-a')).toEqual({ CODEX_HOME: join('/agents/bot-a', '.codex') })
  })

  it('an unregistered runtime is not supported for native', () => {
    expect(isNativeRuntimeSupported(other)).toBe(false)
    expect(nativeRuntimeEnv(other, '/agents/bot-a')).toEqual({})
  })
})

describe('memoryProviderFor (spawn-time provider + env)', () => {
  const agent = (provider: MemoryProviderKind | undefined, runtime = 'claude') => ({
    dir: '/agents/bot-a',
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

  it('native+claude redirects CLAUDE_CONFIG_DIR under the agent root', () => {
    expect(memoryProviderFor(agent('native'), claude).runtimeEnv()).toEqual({
      CLAUDE_CONFIG_DIR: join('/agents/bot-a', '.claude')
    })
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
  // Three agents: managed, native-claude, and explicitly memoryless.
  const roots: Record<string, string> = {}
  const kinds: Record<string, MemoryProviderKind> = { 'bot-m': 'managed', 'bot-n': 'native', 'bot-0': 'none' }
  const runtimes: Record<string, RuntimeDef> = { 'bot-m': claude, 'bot-n': claude, 'bot-0': claude }
  function provider() {
    return createMemoryProvider(
      (id) => roots[id],
      (id) => runtimes[id],
      (id) => kinds[id] ?? 'managed'
    )
  }

  it('managed agent: tools present, list/write hit our <root>/memory dir, index injects', async () => {
    roots['bot-m'] = newDir()
    const p = provider()
    expect(p.toolsForAgent('bot-m').map((t) => t.name)).toContain('writeMemory')
    p.ensure({ agentId: 'bot-m' }, 'bot-m')
    await p.write({ agentId: 'bot-m' }, MEMORY_INDEX, '# idx')
    expect((await p.list({ agentId: 'bot-m' })).map((f) => f.name)).toContain(MEMORY_INDEX)
    expect(await p.standingContextAtSessionStart({ agentId: 'bot-m' })).toContain('# idx')
    await expect(
      p.recallForTurn({ agentId: 'bot-m' }, { turnId: 'turn-1', query: 'q', topK: 5, maxBytes: 8192, timeoutMs: 1000 })
    ).resolves.toEqual([])
    expect(p.adminSurfaceForAgent('bot-m')?.shape).toBe('files')
  })

  it('native agent: NO tools, ensure/inject are no-ops, list reads the runtime memory dir', async () => {
    const root = newDir()
    roots['bot-n'] = root
    const p = provider()
    expect(p.toolsForAgent('bot-n')).toEqual([]) // runtime owns its memory
    p.ensure({ agentId: 'bot-n' }, 'bot-n') // no-op, must not throw
    expect(await p.standingContextAtSessionStart({ agentId: 'bot-n' })).toBe('') // don't double-inject
    expect(p.adminSurfaceForAgent('bot-n')?.shape).toBe('files')
    // Seed a claude-style native memory file and confirm list/read surface it.
    const memDir = join(root, '.claude', 'projects', 'ws-abc', 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'MEMORY.md'), '# native index')
    const files = await p.list({ agentId: 'bot-n' })
    expect(files.some((f) => f.name.endsWith('MEMORY.md'))).toBe(true)
    const nativeFile = files.find((f) => f.name.endsWith('MEMORY.md'))!
    const read = await p.read({ agentId: 'bot-n' }, nativeFile.name)
    expect(read.content).toBe('# native index')
    await expect(p.write({ agentId: 'bot-n' }, nativeFile.name, '# stale write', 'stale')).rejects.toBeInstanceOf(
      MemoryConflictError
    )
    await expect(
      p.write({ agentId: 'bot-n' }, nativeFile.name, '# current write', nativeFile.mtime)
    ).resolves.toMatchObject({ ok: true, path: nativeFile.name })
  })

  it('none: no tools, store, injection, or writes', async () => {
    const p = provider()
    const scope = { agentId: 'bot-0' }
    expect(p.toolsForAgent('bot-0')).toEqual([])
    p.ensure(scope, 'bot-0')
    expect(await p.standingContextAtSessionStart(scope)).toBe('')
    expect(p.adminSurfaceForAgent('bot-0')).toBeNull()
    expect(await p.list(scope)).toEqual([])
    await expect(p.read(scope, MEMORY_INDEX)).rejects.toThrow('persistent memory is disabled')
    await expect(p.write(scope, MEMORY_INDEX, '# nope')).rejects.toThrow('persistent memory is disabled')
  })
})
