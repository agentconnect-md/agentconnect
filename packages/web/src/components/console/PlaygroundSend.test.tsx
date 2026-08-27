// @vitest-environment happy-dom
//
// `pgSend` reports whether a send was ACCEPTED, and SessionDetailView's composer
// relies on that to decide whether to pin the transcript to the bottom. Enter on
// an empty composer must report rejection — otherwise a reader who scrolled up
// into history gets yanked to the bottom for a send that never happened. Enter
// while a turn is already streaming is accepted: it QUEUES (Claude Code-style)
// and dispatches once the turn finishes, and each queued message can be
// cancelled before it goes out.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ agents: [], daemons: [], refreshSessions: vi.fn() })
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org1', slug: 'acme' } }) }))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message)
    }
  },
  agentApiRelayUrl: () => 'wss://relay.test',
  fetchSessionMessages: vi.fn(async () => ({ messages: [] })),
  mintWebchatConversation: vi.fn(async () => ({ conversationId: 'c1' })),
  webchatSocketUrl: () => 'wss://relay.test/ws',
  // Rejects by default so the acceptance tests keep their fail-fast send path
  // (busy clears, the queue dispatcher runs); the post-frame tests resolve it.
  webchatWsUrl: vi.fn(async () => {
    throw new Error('no relay in this test')
  })
}))

const { PlaygroundProvider, usePlayground } = await import('./PlaygroundProvider')

// The accepted path opens a socket; a stub that never settles keeps the test on
// the synchronous return value instead of the streaming machinery.
class StubSocket {
  static CONNECTING = 0
  readyState = 0
  send = vi.fn()
  close = vi.fn()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

let pgSend: ReturnType<typeof usePlayground>['pgSend']
let openPlayground: ReturnType<typeof usePlayground>['openPlayground']
let getPgQueue: ReturnType<typeof usePlayground>['getPgQueue']
let pgCancelQueued: ReturnType<typeof usePlayground>['pgCancelQueued']
let getLiveSteps: ReturnType<typeof usePlayground>['getLiveSteps']
let pgAttach: ReturnType<typeof usePlayground>['pgAttach']

function Probe() {
  const pg = usePlayground()
  pgSend = pg.pgSend
  openPlayground = pg.openPlayground
  getPgQueue = pg.getPgQueue
  pgCancelQueued = pg.pgCancelQueued
  getLiveSteps = pg.getLiveSteps
  pgAttach = pg.pgAttach
  return null
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  Reflect.set(globalThis, 'WebSocket', StubSocket)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <PlaygroundProvider>
        <Probe />
      </PlaygroundProvider>
    )
  )
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

describe('pgSend acceptance', () => {
  it('rejects an empty composer', () => {
    expect(pgSend('s1', 'a1', '')).toBe(false)
    expect(pgSend('s1', 'a1', '   ')).toBe(false) // whitespace only
    expect(pgSend('s1', 'a1', undefined)).toBe(false) // no staged input either
  })

  it('accepts a message with text', () => {
    expect(pgSend('s1', 'a1', 'hello')).toBe(true)
  })

  // A second send while the first turn streams is ACCEPTED — it queues instead
  // of going on the wire, and dispatches once the turn finishes.
  it('queues a second send while the first turn is still streaming', () => {
    act(() => {
      expect(pgSend('s1', 'a1', 'hello')).toBe(true)
    })
    act(() => {
      expect(pgSend('s1', 'a1', 'again')).toBe(true) // busy → queued
    })
    expect(getPgQueue('s1').map((q) => q.text)).toEqual(['again'])
    expect(getPgQueue('s2')).toEqual([]) // per-session queue
  })

  it('cancels a queued message before it is sent', () => {
    act(() => {
      expect(pgSend('s1', 'a1', 'hello')).toBe(true)
    })
    act(() => {
      expect(pgSend('s1', 'a1', 'first queued')).toBe(true)
      expect(pgSend('s1', 'a1', 'second queued')).toBe(true)
    })
    const queued = getPgQueue('s1')
    expect(queued.map((q) => q.text)).toEqual(['first queued', 'second queued'])
    act(() => pgCancelQueued('s1', queued[0]!.queueId))
    expect(getPgQueue('s1').map((q) => q.text)).toEqual(['second queued'])
  })

  it('keeps queueing per session — a different session sends directly', () => {
    act(() => {
      expect(pgSend('s1', 'a1', 'hello')).toBe(true)
    })
    act(() => {
      expect(pgSend('s2', 'a1', 'hello')).toBe(true) // a different session is free
    })
    expect(getPgQueue('s2')).toEqual([]) // sent, not queued
  })

  // The dispatcher drains the queue once the session is no longer busy. In this
  // harness the turn "finishes" when the (mocked, failing) socket settles and
  // clears the busy flag — flushing microtasks gets there without streaming.
  it('auto-dispatches the queued message once the turn ends', async () => {
    act(() => {
      expect(pgSend('s1', 'a1', 'hello')).toBe(true)
    })
    act(() => {
      expect(pgSend('s1', 'a1', 'queued')).toBe(true)
    })
    expect(getPgQueue('s1')).toHaveLength(1)
    await act(async () => {}) // settle the send + run the dispatcher effect
    expect(getPgQueue('s1')).toEqual([])
  })

  // The FIFO gap: when a turn ends, the synchronous busy ref clears at once but
  // the queue head is dispatched by a passive effect. A send landing in that gap
  // must go BEHIND the pending queue, not straight to the wire ahead of it.
  it('keeps a send arriving at the idle transition behind the pending queue', async () => {
    act(() => {
      expect(pgSend('s1', 'a1', 'first')).toBe(true)
    })
    act(() => {
      expect(pgSend('s1', 'a1', 'second')).toBe(true) // busy → queued
    })
    await act(async () => {
      // Pump microtasks so the (mocked, failing) first send settles and clears
      // the busy ref — the dispatcher effect cannot run until this act body
      // returns, so the next send lands exactly in the race window.
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(pgSend('s1', 'a1', 'third')).toBe(true)
    })
    // Drain the dispatcher: each dispatched turn fails and frees the next.
    await act(async () => {})
    await act(async () => {})
    expect(getPgQueue('s1')).toEqual([])
    // '@you' transcript steps record wire order — FIFO means 'third' stays last
    // ('s1' is not a synthetic pg_ session, so its steps land in the live tail).
    const wireOrder = getLiveSteps('s1')
      .filter((s) => s.who === '@you')
      .map((s) => s.text)
    expect(wireOrder).toEqual(['first', 'second', 'third'])
  })

  // The cancel twin of the FIFO gap: the dispatcher must not send a head the
  // user canceled after the turn ended but before the passive effect ran. The
  // dispatcher derives its head from the synchronous queue mirror, so a cancel
  // landing in that window always wins over the render-time snapshot.
  it('never dispatches a head canceled at the idle transition', async () => {
    act(() => {
      expect(pgSend('s1', 'a1', 'first')).toBe(true)
    })
    act(() => {
      expect(pgSend('s1', 'a1', 'doomed')).toBe(true) // busy → queued
    })
    const queueId = getPgQueue('s1')[0]!.queueId
    await act(async () => {
      // Pump microtasks so the (mocked, failing) first send settles and clears
      // the busy ref, then cancel the queued head before the dispatcher effect
      // has had a chance to run.
      for (let i = 0; i < 20; i++) await Promise.resolve()
      pgCancelQueued('s1', queueId)
    })
    await act(async () => {})
    expect(getPgQueue('s1')).toEqual([])
    const wireOrder = getLiveSteps('s1')
      .filter((s) => s.who === '@you')
      .map((s) => s.text)
    expect(wireOrder).toEqual(['first']) // 'doomed' must never reach the wire
  })

  // openPlayground exists on the same context; touching it here documents that the
  // probe wiring is real and not a partially-mocked stand-in.
  it('exposes the real provider surface', () => {
    expect(typeof openPlayground).toBe('function')
  })
})

// #807 follow-up: an agent-initiated post renders once per postId — the daemon may
// re-broadcast the same canonical post (inbox replay, relay fan-out echo).
describe('agent-initiated post frames', () => {
  class CapturingSocket extends StubSocket {
    static instances: CapturingSocket[] = []
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onerror?: (e: unknown) => void
    onclose?: () => void
    constructor() {
      super()
      CapturingSocket.instances.push(this)
    }
  }

  it('dedups a re-broadcast post by postId', async () => {
    CapturingSocket.instances = []
    Reflect.set(globalThis, 'WebSocket', CapturingSocket)
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockResolvedValue('wss://relay.test/ws')
    await act(async () => {
      pgSend('s1', 'agent-1', 'hello', 'c1')
    })
    const sock = CapturingSocket.instances[0]!
    await act(async () => {
      sock.readyState = 1
      sock.onopen?.()
    })
    const frame = JSON.stringify({
      type: 'post',
      initiator: 'agent',
      post: { postId: 'post-9', author: { kind: 'agent', agentId: 'agent-2' }, text: 'hi from B' }
    })
    await act(async () => {
      sock.onmessage?.({ data: frame })
      sock.onmessage?.({ data: frame })
    })
    const posts = getLiveSteps('s1').filter((s) => s.postId === 'post-9')
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ kind: 'done', agentId: 'agent-2', text: 'hi from B' })
  })
})

describe('stream text delta batching', () => {
  class CapturingDeltaSocket extends StubSocket {
    static instances: CapturingDeltaSocket[] = []
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onerror?: (e: unknown) => void
    onclose?: () => void
    constructor() {
      super()
      CapturingDeltaSocket.instances.push(this)
    }
  }

  async function openStream() {
    CapturingDeltaSocket.instances = []
    Reflect.set(globalThis, 'WebSocket', CapturingDeltaSocket)
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockResolvedValue('wss://relay.test/ws')
    await act(async () => {
      pgSend('s1', 'agent-1', 'hello', 'c1')
    })
    const socket = CapturingDeltaSocket.instances[0]!
    await act(async () => {
      socket.readyState = 1
      socket.onopen?.()
    })
    const turn = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { turnId: string }
    return { socket, turnId: turn.turnId }
  }

  function captureAnimationFrames() {
    let nextId = 1
    const frames = new Map<number, FrameRequestCallback>()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextId++
      frames.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    return () => {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(16)
    }
  }

  it('commits several same-frame message deltas as one transcript update', async () => {
    const runFrame = captureAnimationFrames()
    const { socket, turnId } = await openStream()

    act(() => {
      for (const [index, text] of ['Hel', 'lo', '!'].entries()) {
        socket.onmessage?.({
          data: JSON.stringify({
            type: 'output',
            output: { turnId, agentId: 'agent-1', index, event: { kind: 'message', text } }
          })
        })
      }
    })
    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toEqual([])

    act(runFrame)
    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toMatchObject([
      { kind: 'done', text: 'Hello!' }
    ])
  })

  it('renders a daemon notice in the work lane without swallowing the reply that follows', async () => {
    const runFrame = captureAnimationFrames()
    const { socket, turnId } = await openStream()

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: { turnId, agentId: 'agent-1', index: 0, event: { kind: 'notice', text: 'Allocating a sandbox pod…' } }
        })
      })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: { turnId, agentId: 'agent-1', index: 1, event: { kind: 'thinking', text: 'here goes' } }
        })
      })
    })
    act(runFrame)

    // The notice is its own step: `boundary` keeps the thinking chunk from accumulating into it.
    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toMatchObject([
      { kind: 'plan', text: 'Allocating a sandbox pod…', boundary: true },
      { kind: 'plan', text: 'here goes' }
    ])
  })

  it('flushes the final text before applying done', async () => {
    const runFrame = captureAnimationFrames()
    const { socket, turnId } = await openStream()

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: { turnId, agentId: 'agent-1', index: 0, event: { kind: 'thinking', text: 'complete' } }
        })
      })
      socket.onmessage?.({
        data: JSON.stringify({ type: 'done', done: { turnId, agentId: 'agent-1', lastIndex: 0 } })
      })
    })

    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toMatchObject([
      { kind: 'plan', text: 'complete' }
    ])
    act(runFrame)
    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toHaveLength(1)
  })
})

// A socket that drops between `send` and the turn's ack leaves the turn in limbo — it may
// never have reached a daemon. The reconnect must put that turn back on the wire (same
// turnId) rather than only `resume` a stream that was never opened; once a participant
// HAS acked, the reconnect resumes as before.
describe('reconnect after an unacked turn', () => {
  class ReconnectSocket extends StubSocket {
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    static instances: ReconnectSocket[] = []
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onerror?: (e: unknown) => void
    onclose?: () => void
    constructor() {
      super()
      ReconnectSocket.instances.push(this)
    }
  }
  const frames = (socket: ReconnectSocket): Array<Record<string, unknown>> =>
    socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Send one turn, open its socket, and return the socket plus the turn frame it carried. */
  async function sendAndOpen() {
    ReconnectSocket.instances = []
    Reflect.set(globalThis, 'WebSocket', ReconnectSocket)
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockResolvedValue('wss://relay.test/ws')
    await act(async () => {
      pgSend('s1', 'agent-1', 'hello', 'c1')
    })
    const first = ReconnectSocket.instances[0]!
    await act(async () => {
      first.readyState = 1
      first.onopen?.()
    })
    const turn = frames(first)[0] as { turnId: string; text: string }
    expect(turn).toMatchObject({ text: 'hello' })
    return { first, turn }
  }

  /** Drop the socket and run the reconnect backoff until the replacement socket is open and `ready`. */
  async function dropAndReconnect(first: ReconnectSocket) {
    await act(async () => {
      first.readyState = 3
      first.onclose?.()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    const second = ReconnectSocket.instances[1]!
    expect(second).toBeDefined()
    await act(async () => {
      second.readyState = 1
      second.onopen?.()
      second.onmessage?.({ data: JSON.stringify({ type: 'ready', conversationId: 'c1' }) })
    })
    return second
  }

  it('re-sends the turn, not a resume, when no participant acked it before the drop', async () => {
    const { first, turn } = await sendAndOpen()
    const second = await dropAndReconnect(first)
    expect(frames(second)).toEqual([expect.objectContaining({ text: 'hello', turnId: turn.turnId })])
    expect(frames(second).some((frame) => frame.type === 'resume')).toBe(false)
  })

  it('resumes the stream once the turn was acked', async () => {
    const { first, turn } = await sendAndOpen()
    await act(async () => {
      first.onmessage?.({
        data: JSON.stringify({ type: 'ack', ack: { accepted: true, turnId: turn.turnId, agentId: 'agent-1' } })
      })
    })
    const second = await dropAndReconnect(first)
    expect(frames(second)).toEqual([
      expect.objectContaining({ type: 'resume', turnId: turn.turnId, agentId: 'agent-1', afterIndex: -1 })
    ])
  })

  // The copy met its own stream: the original was admitted and its ack lost with the socket.
  it('attaches to the existing stream when the re-sent copy is refused as busy', async () => {
    const { first, turn } = await sendAndOpen()
    const second = await dropAndReconnect(first)
    await act(async () => {
      second.onmessage?.({
        data: JSON.stringify({
          type: 'ack',
          ack: { accepted: false, reason: 'busy', turnId: turn.turnId, agentId: 'agent-1' }
        })
      })
    })
    expect(frames(second).at(-1)).toMatchObject({ type: 'resume', turnId: turn.turnId, agentId: 'agent-1' })
    expect(getLiveSteps('s1').some((step) => /busy/.test(step.text ?? ''))).toBe(false)
  })

  // `busy` for the copy is ambiguous: the attach's verdict tells a duplicate (stream exists → bound,
  // streaming) from the daemon's real refusal (no stream → the agent IS busy; say so, stop retrying).
  it('reports a real busy refusal when the attach after the copy finds no stream', async () => {
    const { first, turn } = await sendAndOpen()
    const second = await dropAndReconnect(first)
    await act(async () => {
      second.onmessage?.({
        data: JSON.stringify({
          type: 'ack',
          ack: { accepted: false, reason: 'busy', turnId: turn.turnId, agentId: 'agent-1' }
        })
      })
      second.onmessage?.({
        data: JSON.stringify({
          type: 'resumed',
          ack: { accepted: false, reason: 'stream_not_found', agentId: 'agent-1' }
        })
      })
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(getLiveSteps('s1').filter((step) => /is busy/.test(step.text ?? ''))).toHaveLength(1)
    // No resume ladder and no "could not be resumed": the busy verdict ended the turn.
    expect(frames(second).filter((frame) => frame.type === 'resume')).toHaveLength(1)
    expect(getLiveSteps('s1').some((step) => /could not be resumed/.test(step.text ?? ''))).toBe(false)
  })

  // The relay mints the canonical post identity per received frame, so a re-sent multi-agent turn
  // partially admitted the first time would duplicate the user message on the rest of the roster.
  it('never re-sends a multi-agent turn — those lanes resume as before', async () => {
    ReconnectSocket.instances = []
    Reflect.set(globalThis, 'WebSocket', ReconnectSocket)
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockResolvedValue('wss://relay.test/ws')
    const roster = [
      { agentId: 'agent-1', name: 'one', primary: true },
      { agentId: 'agent-2', name: 'two' }
    ]
    await act(async () => {
      pgSend('s1', 'agent-1', 'hello both', 'c1', roster)
    })
    const first = ReconnectSocket.instances[0]!
    await act(async () => {
      first.readyState = 1
      first.onopen?.()
    })
    const turn = frames(first)[0] as { turnId: string }
    const second = await dropAndReconnect(first)
    expect(frames(second).map((frame) => frame.type)).toEqual(['resume', 'resume'])
    expect(frames(second).every((frame) => frame.turnId === turn.turnId)).toBe(true)
  })

  it('re-sends at most once per socket — a retry on the same socket falls back to resume', async () => {
    const { first, turn } = await sendAndOpen()
    const second = await dropAndReconnect(first)
    // The daemon never saw the turn AND refuses the copy outright: the retry ladder resumes, not re-sends.
    await act(async () => {
      second.onmessage?.({
        data: JSON.stringify({
          type: 'resumed',
          ack: { accepted: false, reason: 'stream_not_found', agentId: 'agent-1' }
        })
      })
      await vi.advanceTimersByTimeAsync(1_000)
    })
    const sent = frames(second)
    expect(sent.filter((frame) => frame.text === 'hello')).toHaveLength(1)
    expect(sent.at(-1)).toMatchObject({ type: 'resume', turnId: turn.turnId })
  })
})

// A cold attach replays a live turn with NO local prompt step, so the turn-shaped arm
// of `reconcilePersistedLiveSteps` cannot retire it. The reply post's canonical postId
// is the anchor that keeps the transcript tail from rendering the answer twice.
describe('cold-attach retirement anchor', () => {
  class AttachSocket extends StubSocket {
    static instances: AttachSocket[] = []
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onerror?: (e: unknown) => void
    onclose?: () => void
    constructor() {
      super()
      AttachSocket.instances.push(this)
    }
  }

  async function coldAttach() {
    AttachSocket.instances = []
    Reflect.set(globalThis, 'WebSocket', AttachSocket)
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockResolvedValue('wss://relay.test/ws')
    await act(async () => {
      pgAttach('s-cold', 'agent-1', 'c-cold')
    })
    const socket = AttachSocket.instances[0]!
    await act(async () => {
      socket.readyState = 1
      socket.onopen?.()
      socket.onmessage?.({
        data: JSON.stringify({ type: 'ready', conversationId: 'c-cold', participants: [{ agentId: 'agent-1' }] })
      })
    })
    return socket
  }

  it('probes on ready and stamps the reply postId on the replayed steps', async () => {
    const socket = await coldAttach()
    expect(socket.send.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual({
      type: 'attach',
      agentId: 'agent-1'
    })
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'attached',
          ack: { accepted: true, turnId: 'turn-cold', agentId: 'agent-1', generation: 4 }
        })
      })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: {
            turnId: 'turn-cold',
            agentId: 'agent-1',
            index: 0,
            event: { kind: 'tool_call', toolCallId: 't1', title: 'Read file', status: 'completed' }
          }
        })
      })
    })
    expect(getLiveSteps('s-cold').filter((s) => s.turnId === 'turn-cold')).toHaveLength(1)
    // Human-initiated: no `initiator`, so the frame only carries the anchor.
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'post',
          post: { postId: 'post-cold', author: { kind: 'agent', agentId: 'agent-1' }, text: 'done' }
        })
      })
      socket.onmessage?.({ data: JSON.stringify({ type: 'done', done: { turnId: 'turn-cold', agentId: 'agent-1' } }) })
    })
    const replayed = getLiveSteps('s-cold').filter((s) => s.turnId === 'turn-cold')
    expect(replayed.length).toBeGreaterThan(0)
    expect(replayed.every((s) => s.postId === 'post-cold')).toBe(true)
  })

  it('anchors when the reply post arrives after done (the failure path order)', async () => {
    const socket = await coldAttach()
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'attached', ack: { accepted: true, turnId: 'turn-late', agentId: 'agent-1' } })
      })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: {
            turnId: 'turn-late',
            agentId: 'agent-1',
            index: 0,
            event: { kind: 'tool_call', toolCallId: 't1', title: 'Read file', status: 'completed' }
          }
        })
      })
      socket.onmessage?.({ data: JSON.stringify({ type: 'done', done: { turnId: 'turn-late', agentId: 'agent-1' } }) })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'post',
          post: { postId: 'post-late', author: { kind: 'agent', agentId: 'agent-1' }, text: 'partial' }
        })
      })
    })
    const replayed = getLiveSteps('s-cold').filter((s) => s.turnId === 'turn-late')
    expect(replayed.length).toBeGreaterThan(0)
    expect(replayed.every((s) => s.postId === 'post-late')).toBe(true)
  })
})
