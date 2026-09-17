import { describe, expect, it } from 'vitest'
import { AcpRunner } from '../src/shim/acp-runner.js'
import { ShimChannelLostError } from '../src/shim/channels.js'
import { createRemoteRuntime } from '../src/k8s/remote-runtime.js'
import type { ShimConnection } from '../src/shim/connection.js'
import type { ShimEvent } from '../src/shim/protocol.js'
import { ShimSession } from '../src/shim/session.js'

// A credential renewal fails the write in flight without saying whether its bytes reached the
// sandbox. Before this, that single lost write errored the runtime's `WritableStream` for good:
// the sandbox stayed healthy, the host stayed warm, and every later turn — new session or reply —
// died on the SAME stored "shim channel renewed" error. Observed in production as an agent that
// answered nothing for hours while its pod looked perfectly fine.

const silent = { info: () => {}, warn: () => {} }

/** Drain what the runtime writes back, so a test can read the bytes the sandbox actually applied. */
function chunksOf(events: Array<{ kind: string; data?: string }>): string {
  return events
    .filter((event) => event.kind === 'chunk' && event.data)
    .map((event) => Buffer.from(event.data!, 'base64').toString())
    .join('')
}

/** A bound connection at one generation, enough for `ShimSession.attach`. */
function connectionAt(generation: number): ShimConnection {
  return {
    binding: {
      agentId: 'agent-a',
      sandboxUid: 'sandbox-uid-1',
      generation,
      grants: ['acp'],
      podName: 'p',
      podUid: 'u',
      expiresAtMs: Number.MAX_SAFE_INTEGER
    },
    issuedCredential: `cred-${Math.random()}`,
    send: () => {},
    onFrame: () => {},
    close: () => {}
  }
}

describe('ShimSession.waitForAttach', () => {
  const timers = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout)
  }

  it('settles at once on an attached session, and on the next attach otherwise', async () => {
    const session = new ShimSession('agent-a', 3, timers)
    const waited = session.waitForAttach(1_000)
    session.attach(connectionAt(3))
    await expect(waited).resolves.toBeUndefined()
    // Already attached: the re-send has nothing to wait for.
    await expect(session.waitForAttach(1_000)).resolves.toBeUndefined()
  })

  it('rejects on the grace window and once the launch is lost, so a retry cannot hang on a gone pod', async () => {
    const session = new ShimSession('agent-a', 3, timers)
    await expect(session.waitForAttach(20)).rejects.toThrow(/did not re-attach/)
    session.lose('pod deleted')
    await expect(session.waitForAttach(1_000)).rejects.toThrow(/closed/)
  })
})

describe('ACP writes across a shim channel renewal', () => {
  it('applies a re-sent chunk once, so a retry cannot duplicate an ND-JSON frame', async () => {
    // `cat` is the runtime here: whatever reaches its stdin comes straight back as chunk events,
    // which is exactly the evidence this needs — not that the shim answered, but what it wrote.
    const events: Array<{ kind: string; data?: string }> = []
    const runner = new AcpRunner({ emit: (event: ShimEvent['event']) => events.push(event), log: silent })
    await runner.apply({ op: 'open', command: 'cat', args: [], env: {} })

    const chunk = (text: string, seq: number): Promise<void> =>
      runner.apply({ op: 'chunk', data: Buffer.from(text).toString('base64'), seq })
    await chunk('first\n', 0)
    // The renewal case: the daemon never learned whether seq 0 landed and asks again.
    await chunk('first\n', 0)
    await chunk('second\n', 1)

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(chunksOf(events)).toBe('first\nsecond\n')
    await runner.close(1_000).catch(() => undefined)
  })

  it('dedupes a re-send that arrives while its first attempt is still being written', async () => {
    // The shim serves requests concurrently. A chunk that reached the pod just before the socket
    // closed can still be inside its stdin write when the re-send lands on the new socket, and a
    // dedupe that only compared against writes already RECORDED would let both through.
    const events: Array<{ kind: string; data?: string }> = []
    const runner = new AcpRunner({ emit: (event: ShimEvent['event']) => events.push(event), log: silent })
    await runner.apply({ op: 'open', command: 'cat', args: [], env: {} })
    const child = (runner as unknown as { child: { stdin: { write: unknown } } }).child
    const realWrite = child.stdin.write as (bytes: Buffer, cb: (err?: Error) => void) => void
    // Hold the first write's completion, so the second request has to overtake it to duplicate.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    child.stdin.write = (bytes: Buffer, cb: (err?: Error) => void) => {
      child.stdin.write = realWrite
      realWrite.call(child.stdin, bytes, () => void held.then(() => cb()))
    }

    const first = runner.apply({ op: 'chunk', data: Buffer.from('once\n').toString('base64'), seq: 0 })
    const again = runner.apply({ op: 'chunk', data: Buffer.from('once\n').toString('base64'), seq: 0 })
    release()
    await Promise.all([first, again])

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(chunksOf(events)).toBe('once\n')
    await runner.close(1_000).catch(() => undefined)
  })

  it('still applies a re-sent chunk whose first attempt failed', async () => {
    // The seq is recorded after the write, not before: a write that threw was never applied, and
    // a dedupe that swallowed its retry would silently drop bytes instead of duplicating them.
    const events: Array<{ kind: string; data?: string }> = []
    const runner = new AcpRunner({ emit: (event: ShimEvent['event']) => events.push(event), log: silent })
    await runner.apply({ op: 'open', command: 'cat', args: [], env: {} })
    const child = (runner as unknown as { child: { stdin: { write: unknown } } }).child
    const realWrite = child.stdin.write
    child.stdin.write = (_bytes: Buffer, cb: (err?: Error) => void) => cb(new Error('stdin busy'))

    await expect(runner.apply({ op: 'chunk', data: Buffer.from('only\n').toString('base64'), seq: 0 })).rejects.toThrow(
      'stdin busy'
    )
    child.stdin.write = realWrite
    await runner.apply({ op: 'chunk', data: Buffer.from('only\n').toString('base64'), seq: 0 })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(chunksOf(events)).toBe('only\n')
    await runner.close(1_000).catch(() => undefined)
  })

  it('re-sends a write the renewal failed, with the seq it first went out with', async () => {
    const sent: Array<Record<string, unknown>> = []
    let lose = false
    const session = {
      agentId: 'agent-a',
      request: async (_capability: string, payload: Record<string, unknown>) => {
        sent.push(payload)
        if (payload.op === 'open') return { streamId: 's1', resumableWrites: true }
        if (lose) {
          lose = false
          throw new ShimChannelLostError('shim channel renewed')
        }
        return {}
      },
      onEvent: () => {},
      offEvent: () => {},
      onLost: () => {},
      waitForAttach: async () => undefined
    } as unknown as ShimSession

    const runtime = createRemoteRuntime({ session, request: { command: 'claude', args: [], env: {} }, log: silent })
    const writer = runtime.toAgent.getWriter()
    await writer.write(Buffer.from('a'))
    lose = true
    await writer.write(Buffer.from('b'))

    const writes = sent.filter((payload) => payload.op === 'chunk')
    // Three requests for two writes: the second went out, was lost, and went out again UNCHANGED.
    expect(writes).toHaveLength(3)
    expect(writes[1]).toEqual(writes[2])
    expect(writes.map((payload) => payload.seq)).toEqual([1, 2, 2])
  })

  it('ends the runtime when the write cannot be re-sent, rather than erroring the stream forever', async () => {
    // A shim that does not announce the dedupe must not be asked twice, so the only correct move
    // is a terminal exit: `reapTerminalHost` then respawns on the next message. Keeping the host
    // warm on an errored stream is the production failure this exists to prevent.
    const order: string[] = []
    const session = {
      agentId: 'agent-a',
      request: async (_capability: string, payload: Record<string, unknown>) => {
        if (payload.op === 'open') return { streamId: 's1' }
        if (payload.op === 'close') {
          order.push(`close:${String(payload.streamId)}`)
          return {}
        }
        throw new ShimChannelLostError('shim channel renewed')
      },
      onEvent: () => {},
      offEvent: () => {},
      onLost: () => {},
      waitForAttach: async () => undefined
    } as unknown as ShimSession

    const runtime = createRemoteRuntime({ session, request: { command: 'claude', args: [], env: {} }, log: silent })
    runtime.onExit(() => order.push('exit'))
    const writer = runtime.toAgent.getWriter()
    await expect(writer.write(Buffer.from('a'))).rejects.toBeInstanceOf(ShimChannelLostError)
    // The child in the pod is told to stop BEFORE the exit goes out: that exit clears AcpHost's
    // spawned handle, after which host teardown sends this stream no close of its own — and a
    // runner left alive here meant the next message launched a second adapter beside it.
    expect(order).toEqual(['close:s1', 'exit'])
    // Teardown that follows finds the stream already closed and does not ask twice.
    await runtime.stop(1_000)
    expect(order).toEqual(['close:s1', 'exit'])
  })
})
