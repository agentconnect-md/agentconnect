import { describe, expect, it } from 'vitest'
import { AcpRunner } from '../src/shim/acp-runner.js'
import { ShimChannelLostError } from '../src/shim/channels.js'
import { createRemoteRuntime } from '../src/k8s/remote-runtime.js'
import type { ShimSession } from '../src/shim/session.js'

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

describe('ACP writes across a shim channel renewal', () => {
  it('applies a re-sent chunk once, so a retry cannot duplicate an ND-JSON frame', async () => {
    // `cat` is the runtime here: whatever reaches its stdin comes straight back as chunk events,
    // which is exactly the evidence this needs — not that the shim answered, but what it wrote.
    const events: Array<{ kind: string; data?: string }> = []
    const runner = new AcpRunner({ emit: (event) => events.push(event), log: silent } as never)
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

  it('still applies a re-sent chunk whose first attempt failed', async () => {
    // The seq is recorded after the write, not before: a write that threw was never applied, and
    // a dedupe that swallowed its retry would silently drop bytes instead of duplicating them.
    const events: Array<{ kind: string; data?: string }> = []
    const runner = new AcpRunner({ emit: (event) => events.push(event), log: silent } as never)
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
    const session = {
      agentId: 'agent-a',
      request: async (_capability: string, payload: Record<string, unknown>) => {
        if (payload.op === 'open') return { streamId: 's1' }
        throw new ShimChannelLostError('shim channel renewed')
      },
      onEvent: () => {},
      offEvent: () => {},
      onLost: () => {},
      waitForAttach: async () => undefined
    } as unknown as ShimSession

    let exited = false
    const runtime = createRemoteRuntime({ session, request: { command: 'claude', args: [], env: {} }, log: silent })
    runtime.onExit(() => (exited = true))
    const writer = runtime.toAgent.getWriter()
    await expect(writer.write(Buffer.from('a'))).rejects.toBeInstanceOf(ShimChannelLostError)
    expect(exited).toBe(true)
  })
})
