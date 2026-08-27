import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpHost } from '../src/acp/acp-host.js'
import { LocalDriver, resolveWindowsCodexNative, sanitizeWindowsCodexAdapterEnv } from '../src/acp/spawn-driver.js'
import type { SpawnDriver, SpawnRequest, SpawnedRuntime } from '../src/acp/spawn-driver.js'

/**
 * The seam's whole purpose: `AcpHost` speaks ACP over a byte-stream pair and a
 * lifecycle, with no knowledge of where the runtime runs. This drives it with an
 * in-memory ACP agent and no process anywhere — the same shape a cluster driver
 * will present when the runtime lives in a sandbox pod.
 */

interface Rpc {
  id?: number
  method?: string
  params?: any
}

describe('Windows Codex executable hint', () => {
  it('resolves the native executable behind the global npm shim', () => {
    const resolved = resolveWindowsCodexNative('C:\\npm\\codex.CMD', 'win32', 'x64', {
      exists: () => true,
      realpath: (path) => path
    })
    expect(resolved?.toLowerCase()).toMatch(/codex-win32-x64.+codex\.exe$/)
  })

  it('removes permission overrides that cmd.exe would split into subcommands', () => {
    const env = { CODEX_ACP_PERMISSION_PROFILE_CONFIG: '{"configOverrides":["filesystem={ \":root\" = \"write\" }"]}' }
    expect(sanitizeWindowsCodexAdapterEnv(env, [{ envVar: 'CODEX_PATH', command: 'codex' }], 'win32')).toBe(true)
    expect(env).not.toHaveProperty('CODEX_ACP_PERMISSION_PROFILE_CONFIG')
  })
})

/** A minimal in-memory ACP agent wired to a `SpawnedRuntime` stream pair. */
function inMemoryRuntime(): { runtime: SpawnedRuntime; stopCalls: number[] } {
  const toAgentChunks = new TransformStream<Uint8Array, Uint8Array>()
  const fromAgent = new TransformStream<Uint8Array, Uint8Array>()
  const writer = fromAgent.writable.getWriter()
  const encoder = new TextEncoder()
  const send = (message: unknown) => writer.write(encoder.encode(`${JSON.stringify(message)}\n`))
  const stopCalls: number[] = []
  const exitListeners: Array<() => void> = []
  let sessions = 0

  void (async () => {
    const decoder = new TextDecoder()
    let buffered = ''
    for await (const chunk of toAgentChunks.readable as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const rpc = JSON.parse(line) as Rpc
        if (rpc.id === undefined) continue // notification
        if (rpc.method === 'initialize') {
          await send({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              agentInfo: { name: 'in-memory', version: '0.0.0' }
            }
          })
        } else if (rpc.method === 'session/new') {
          await send({ jsonrpc: '2.0', id: rpc.id, result: { sessionId: `mem-${++sessions}` } })
        } else if (rpc.method === 'session/prompt') {
          const sessionId = rpc.params?.sessionId
          await send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'from-memory' } }
            }
          })
          await send({ jsonrpc: '2.0', id: rpc.id, result: { stopReason: 'end_turn' } })
        } else {
          await send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `no ${rpc.method}` } })
        }
      }
    }
  })()

  const runtime: SpawnedRuntime = {
    toAgent: toAgentChunks.writable,
    fromAgent: fromAgent.readable,
    onExit: (listener) => exitListeners.push(listener),
    stop: async (deadlineMs) => {
      stopCalls.push(deadlineMs)
      for (const listener of exitListeners.splice(0)) listener()
    }
  }
  return { runtime, stopCalls }
}

class InMemoryDriver implements SpawnDriver {
  requests: SpawnRequest[] = []
  constructor(private target: SpawnedRuntime) {}
  async launch(request: SpawnRequest): Promise<SpawnedRuntime> {
    this.requests.push(request)
    return this.target
  }
}

describe('SpawnDriver seam', () => {
  it('runs a full ACP turn against a driver that owns no process', async () => {
    const { runtime, stopCalls } = inMemoryRuntime()
    const driver = new InMemoryDriver(runtime)
    const updates: string[] = []
    const host = new AcpHost(
      { command: 'irrelevant', args: ['--acp'], env: [{ name: 'FROM_RUNTIME_DEF', value: 'yes' }] },
      {
        driver,
        onUpdate: (_sessionId, update) => {
          if (update.sessionUpdate === 'agent_message_chunk' && (update as any).content?.type === 'text') {
            updates.push((update as any).content.text)
          }
        }
      }
    )

    await host.start()
    const sessionId = await host.newSession('/tmp')
    const result = await host.prompt(sessionId, [{ type: 'text', text: 'hello' }])

    expect(result.stopReason).toBe('end_turn')
    expect(updates).toContain('from-memory')
    // The driver receives the assembled launch, not a pre-resolved local command:
    // resolving it against a filesystem is the driver's job, since only it knows
    // which filesystem the runtime will see.
    expect(driver.requests).toHaveLength(1)
    expect(driver.requests[0]?.command).toBe('irrelevant')
    expect(driver.requests[0]?.args).toEqual(['--acp'])
    expect(driver.requests[0]?.env.FROM_RUNTIME_DEF).toBe('yes')

    await host.stop(1234)
    expect(stopCalls).toEqual([1234])
  })

  it('refuses a second start and reports terminal exit through the driver', async () => {
    const { runtime } = inMemoryRuntime()
    let terminal = 0
    const host = new AcpHost(
      { command: 'irrelevant', args: [], env: [] },
      { driver: new InMemoryDriver(runtime), onUpdate: () => {}, onTerminal: () => terminal++ }
    )
    await host.start()
    await expect(host.start()).rejects.toThrow(/already started/)

    // The driver, not AcpHost, decides when the target is gone; AcpHost drops its
    // handle so a later stop() is a no-op rather than a wait on a dead target.
    await host.stop(10)
    expect(terminal).toBe(1)
    await host.stop(10)
    expect(terminal).toBe(1)
  })

  it('asks the driver to resolve installed CLI hints for adapter runtimes', async () => {
    const claude = new InMemoryDriver(inMemoryRuntime().runtime)
    const claudeHost = new AcpHost(
      { command: 'claude-code-acp', args: [], env: [] },
      { driver: claude, onUpdate: () => {} }
    )
    await claudeHost.start()
    expect(claude.requests[0]?.hints).toEqual([{ envVar: 'CLAUDE_CODE_EXECUTABLE', command: 'claude' }])
    await claudeHost.stop(10)

    const other = new InMemoryDriver(inMemoryRuntime().runtime)
    const otherHost = new AcpHost({ command: 'codex-acp', args: [], env: [] }, { driver: other, onUpdate: () => {} })
    await otherHost.start()
    expect(other.requests[0]?.hints).toEqual([{ envVar: 'CODEX_PATH', command: 'codex' }])
    await otherHost.stop(10)

    const npx = new InMemoryDriver(inMemoryRuntime().runtime)
    const npxHost = new AcpHost(
      { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@1.6.2'], env: [] },
      { driver: npx, onUpdate: () => {} }
    )
    await npxHost.start()
    expect(npx.requests[0]?.hints).toEqual([{ envVar: 'CODEX_PATH', command: 'codex' }])
    await npxHost.stop(10)
  })
})

/**
 * A missing or unrunnable command must fail the launch, not the daemon. Node emits
 * `error` (and then `close`) on the ChildProcess with no `exit`; an unhandled
 * `error` event is rethrown as an uncaught exception, which would take down every
 * other agent this daemon runs.
 */
describe('LocalDriver spawn failures', () => {
  const missing = join(tmpdir(), 'agentconnect-nonexistent-runtime')

  it('surfaces the spawn error on the agent stream instead of crashing the process', async () => {
    const driver = new LocalDriver()
    const runtime = await driver.launch({ command: missing, args: ['acp'], env: {} })
    await expect(new Response(runtime.fromAgent as any).text()).rejects.toThrow(/ENOENT/)
  })

  it('stops immediately instead of waiting out the kill deadline for a pid that never existed', async () => {
    const driver = new LocalDriver()
    const runtime = await driver.launch({ command: missing, args: ['acp'], env: {} })
    await new Promise<void>((resolve) => runtime.onExit(resolve))
    const started = Date.now()
    await runtime.stop(5000)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('reaches terminal exit so lifecycle waiters do not hang', async () => {
    const driver = new LocalDriver()
    const runtime = await driver.launch({ command: missing, args: ['acp'], env: {} })
    await expect(
      new Promise<void>((resolve, reject) => {
        runtime.onExit(resolve)
        setTimeout(() => reject(new Error('onExit never fired after a failed spawn')), 2000)
      })
    ).resolves.toBeUndefined()
  })
})
