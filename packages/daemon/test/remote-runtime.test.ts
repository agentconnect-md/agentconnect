import { describe, expect, it, vi } from 'vitest'
import { createRemoteRuntime } from '../src/remote/remote-runtime.js'
import type { ShimEvent } from '../src/shim/protocol.js'
import type { ShimSession } from '../src/shim/session.js'

const silent = { info: () => {}, warn: () => {} }
const request = { command: 'claude', args: [], env: {} }

/** A session whose open reply is held, so a test decides what arrives before the stream has a name. */
function heldSession() {
  let listener: ((event: ShimEvent) => void) | undefined
  let reply!: (payload: unknown) => void
  const sent: Array<Record<string, unknown>> = []
  const session = {
    agentId: 'agent-a',
    request: (_capability: string, payload: Record<string, unknown>) => {
      sent.push(payload)
      return payload.op === 'open' ? new Promise((resolve) => (reply = resolve)) : Promise.resolve({})
    },
    onEvent: (next: (event: ShimEvent) => void) => (listener = next),
    offEvent: () => (listener = undefined),
    onLost: () => {},
    waitForAttach: async () => undefined
  } as unknown as ShimSession
  const emit = (streamId: string, event: ShimEvent['event']): void =>
    listener?.({ type: 'shim/event', streamId, event })
  return { session, sent, emit, open: (streamId: string) => reply({ streamId, resumableWrites: true }) }
}

const chunk = (text: string): ShimEvent['event'] => ({ kind: 'chunk', data: Buffer.from(text).toString('base64') })

describe('createRemoteRuntime', () => {
  it('does not read another stream on its session as its own while its open is still in flight', async () => {
    // The session also carries the sandbox's helper tunnels, and one hanging up in this window used to read as the runtime's exit.
    const { session, emit, open } = heldSession()
    const runtime = createRemoteRuntime({ session, request, log: silent })
    const exited = vi.fn()
    runtime.onExit(exited)
    emit('tunnel-1', chunk('protocol=https\n'))
    emit('tunnel-1', { kind: 'exit', code: 0, signal: null })
    // The runtime's own first bytes can share a socket read with the reply that names its stream.
    emit('acp-1', chunk('{"jsonrpc":"2.0"}\n'))
    open('acp-1')
    const reader = runtime.fromAgent.getReader()
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('{"jsonrpc":"2.0"}\n')
    expect(exited).not.toHaveBeenCalled()
    emit('acp-1', { kind: 'exit', code: 0, signal: null })
    expect((await reader.read()).done).toBe(true)
    expect(exited).toHaveBeenCalledOnce()
  })

  it('reports a lost session to a running runtime, and says nothing for one that already ended', async () => {
    const warnings: string[] = []
    const lost: Array<(reason: string) => void> = []
    const { session, emit, open } = heldSession()
    ;(session as unknown as { onLost: (listener: (reason: string) => void) => void }).onLost = (listener) =>
      void lost.push(listener)
    const log = { info: () => {}, warn: (message: string) => void warnings.push(message) }
    const ended = createRemoteRuntime({ session, request, log })
    open('acp-1')
    await ended.toAgent.getWriter().write(Buffer.from('x'))
    emit('acp-1', { kind: 'exit', code: 0, signal: null })
    const running = createRemoteRuntime({ session, request, log })
    const exited = vi.fn()
    running.onExit(exited)
    // An idle VM being suspended ends the session every runtime it ever carried was opened on.
    for (const listener of lost) listener('sandbox suspended')
    expect(exited).toHaveBeenCalledOnce()
    expect(warnings).toHaveLength(1)
  })

  it('starts the runtime in the directory its caller names, and leaves it to the shim otherwise', () => {
    const named = heldSession()
    createRemoteRuntime({ session: named.session, request, cwd: '/workspace', log: silent })
    expect(named.sent[0]).toMatchObject({ op: 'open', cwd: '/workspace' })
    const unnamed = heldSession()
    createRemoteRuntime({ session: unnamed.session, request, log: silent })
    expect(unnamed.sent[0]).not.toHaveProperty('cwd')
  })
})
