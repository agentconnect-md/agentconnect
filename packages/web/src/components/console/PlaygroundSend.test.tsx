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
  // The provider reuses a socket only while `readyState` reads as OPEN against the class constant.
  static OPEN = 1
  readyState = 0
  send = vi.fn()
  close = vi.fn()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

let pgSend: ReturnType<typeof usePlayground>['pgSend']
let pgNotice: ReturnType<typeof usePlayground>['pgNotice']
let setPgInput: ReturnType<typeof usePlayground>['setPgInput']
let getPgInput: ReturnType<typeof usePlayground>['getPgInput']
let setPgImage: ReturnType<typeof usePlayground>['setPgImage']
let getPgImage: ReturnType<typeof usePlayground>['getPgImage']
let openPlayground: ReturnType<typeof usePlayground>['openPlayground']
let getPgQueue: ReturnType<typeof usePlayground>['getPgQueue']
let pgCancelQueued: ReturnType<typeof usePlayground>['pgCancelQueued']
let getLiveSteps: ReturnType<typeof usePlayground>['getLiveSteps']
let pgAttach: ReturnType<typeof usePlayground>['pgAttach']
let pgAnswerElicitation: ReturnType<typeof usePlayground>['pgAnswerElicitation']
let pgAppRpc: ReturnType<typeof usePlayground>['pgAppRpc']

function Probe() {
  const pg = usePlayground()
  pgSend = pg.pgSend
  pgNotice = pg.pgNotice
  setPgInput = pg.setPgInput
  getPgInput = pg.getPgInput
  setPgImage = pg.setPgImage
  getPgImage = pg.getPgImage
  openPlayground = pg.openPlayground
  getPgQueue = pg.getPgQueue
  pgCancelQueued = pg.pgCancelQueued
  getLiveSteps = pg.getLiveSteps
  pgAttach = pg.pgAttach
  pgAnswerElicitation = pg.pgAnswerElicitation
  pgAppRpc = pg.pgAppRpc
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

// An approval decision is news the conversation must speak, but the composer is
// the OWNER's: clicking Approve while a follow-up is half-typed (or an image is
// staged) must not send their draft, and must not send their image with the notice.
describe('pgNotice leaves the composer alone', () => {
  const image = { name: 'shot.png', mimeType: 'image/png' as const, data: 'AAAA' }

  it('keeps an unsent draft and a staged attachment exactly where they were', () => {
    act(() => setPgInput('s1', 'half-typed follow-up'))
    act(() => setPgImage('s1', image))
    expect(pgNotice('s1', 'a1', '[approval] createAgent (operation op-1) is now completed.')).toBe(true)
    expect(getPgInput('s1')).toBe('half-typed follow-up')
    expect(getPgImage('s1')).toEqual(image)
  })

  it('sends nothing for an empty notice, and never pulls the staged image in', () => {
    act(() => setPgImage('s1', image))
    expect(pgNotice('s1', 'a1', '   ')).toBe(false)
    expect(getPgImage('s1')).toEqual(image)
  })

  it('still queues behind a streaming turn, like any other input', () => {
    act(() => {
      expect(pgSend('s1', 'a1', 'hello')).toBe(true)
    })
    act(() => {
      expect(pgNotice('s1', 'a1', '[approval] createAgent is now completed.')).toBe(true)
    })
    expect(getPgQueue('s1').map((q) => q.text)).toEqual(['[approval] createAgent is now completed.'])
    // Queued as text only: the owner's staged image is not conscripted into it.
    expect(getPgQueue('s1').map((q) => q.image)).toEqual([undefined])
  })
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

  it('renders a daemon notice in its own lane while the wait it announces is all there is', async () => {
    const runFrame = captureAnimationFrames()
    const { socket, turnId } = await openStream()

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: { turnId, agentId: 'agent-1', index: 0, event: { kind: 'notice', text: 'Allocating a sandbox pod…' } }
        })
      })
    })
    act(runFrame)

    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toMatchObject([
      { kind: 'notice', text: 'Allocating a sandbox pod…', boundary: true }
    ])
  })

  it('replaces and clears only the current turn wait while keeping standing notices and other participants', async () => {
    const runFrame = captureAnimationFrames()
    const { socket, turnId } = await openStream()
    act(() => {
      for (const output of [
        { agentId: 'agent-1', index: 0, event: { kind: 'notice', text: 'Starting sandbox…' } },
        { agentId: 'agent-2', index: 0, event: { kind: 'notice', text: 'Starting sandbox…' } },
        { agentId: 'agent-1', index: 1, event: { kind: 'notice', text: 'An approval is unavailable', standing: true } },
        { agentId: 'agent-1', index: 2, event: { kind: 'notice', text: 'Preparing workspace…' } }
      ])
        socket.onmessage?.({ data: JSON.stringify({ type: 'output', output: { turnId, ...output } }) })
    })
    act(runFrame)
    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toMatchObject([
      { kind: 'notice', text: 'An approval is unavailable', standing: true },
      { kind: 'notice', text: 'Preparing workspace…' }
    ])
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: {
            turnId,
            agentId: 'agent-1',
            index: 3,
            event: { kind: 'notice', text: '' }
          }
        })
      })
    })
    act(runFrame)
    expect(getLiveSteps('s1').filter((step) => step.kind === 'notice')).toMatchObject([
      { agentId: 'agent-2', text: 'Starting sandbox…' },
      { agentId: 'agent-1', text: 'An approval is unavailable', standing: true }
    ])
  })

  it('retires the notice as soon as the turn streams, so it never stands above the answer', async () => {
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
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: { turnId, agentId: 'agent-1', index: 2, event: { kind: 'message', text: 'Hello!' } }
        })
      })
    })
    act(runFrame)

    // The pod is up — the wait's line is gone, and the reply chunks still start their own blocks.
    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toMatchObject([
      { kind: 'plan', text: 'here goes' },
      { kind: 'done', text: 'Hello!' }
    ])
  })

  it('keeps a STANDING notice when the turn streams on — it is not a wait that ended', async () => {
    const runFrame = captureAnimationFrames()
    const { socket, turnId } = await openStream()

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: {
            turnId,
            agentId: 'agent-1',
            index: 0,
            event: { kind: 'notice', text: 'The agent asked something this chat can’t collect…', standing: true }
          }
        })
      })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: { turnId, agentId: 'agent-1', index: 1, event: { kind: 'message', text: 'Moving on then.' } }
        })
      })
    })
    act(runFrame)

    // Retiring this one would delete the ONLY thing the reader was told about a question the
    // agent asked and this surface could not show (#1794) — the answer that follows is not
    // the wait ending, it is the agent carrying on without them.
    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toMatchObject([
      { kind: 'notice', text: 'The agent asked something this chat can’t collect…', standing: true, boundary: true },
      { kind: 'done', text: 'Moving on then.' }
    ])
  })

  // ACP resends the WHOLE list on every revision, so a live plan must be one block that is
  // rewritten — appending would stack a fresh checklist per keystroke of progress.
  it("replaces the lane's plan block on each revision instead of appending another", async () => {
    const runFrame = captureAnimationFrames()
    const { socket, turnId } = await openStream()

    act(() => {
      for (const output of [
        {
          agentId: 'agent-1',
          index: 0,
          event: {
            kind: 'plan',
            entries: [
              { content: 'read the file', status: 'in_progress' },
              { content: 'fix the bug', status: 'pending' }
            ]
          }
        },
        {
          agentId: 'agent-1',
          index: 1,
          event: { kind: 'tool_call', toolCallId: 't1', title: 'cat a.ts', status: 'pending' }
        },
        {
          agentId: 'agent-1',
          index: 2,
          event: {
            kind: 'plan',
            entries: [
              { content: 'read the file', status: 'completed' },
              { content: 'fix the bug', status: 'in_progress' }
            ]
          }
        }
      ]) {
        socket.onmessage?.({ data: JSON.stringify({ type: 'output', output: { turnId, ...output } }) })
      }
    })
    act(runFrame)

    // One block, holding the position it first took — ahead of the tool it planned — and
    // carrying the latest statuses.
    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toMatchObject([
      {
        kind: 'planblock',
        plan: [
          { content: 'read the file', status: 'completed' },
          { content: 'fix the bug', status: 'in_progress' }
        ]
      },
      { kind: 'tool', text: 'cat a.ts' }
    ])
  })

  // The daemon builds ONE TranscriptRecorder per turn, so a replacement generation rewrites
  // the SAME plan row. Appending here instead would leave the live view showing the
  // discarded plan next to the current one, where a reload shows only the latter.
  it('rewrites the same plan block across a supersession instead of stacking a second', async () => {
    const runFrame = captureAnimationFrames()
    const { socket, turnId } = await openStream()

    act(() => {
      for (const output of [
        {
          agentId: 'agent-1',
          index: 0,
          event: { kind: 'plan', entries: [{ content: 'first attempt', status: 'in_progress' }] }
        },
        { agentId: 'agent-1', index: 1, event: { kind: 'superseded', generation: 1 } },
        {
          agentId: 'agent-1',
          index: 2,
          event: { kind: 'plan', entries: [{ content: 'second attempt', status: 'in_progress' }] }
        }
      ]) {
        socket.onmessage?.({ data: JSON.stringify({ type: 'output', output: { turnId, ...output } }) })
      }
    })
    act(runFrame)

    const blocks = getLiveSteps('s1').filter((step) => step.kind === 'planblock')
    expect(blocks).toMatchObject([{ plan: [{ content: 'second attempt', status: 'in_progress' }] }])
  })

  it("retires only the streaming lane's notice — a lane still waiting keeps its own", async () => {
    const runFrame = captureAnimationFrames()
    const { socket, turnId } = await openStream()

    act(() => {
      for (const output of [
        { agentId: 'agent-1', index: 0, event: { kind: 'notice', text: 'Allocating a sandbox pod…' } },
        { agentId: 'agent-2', index: 0, event: { kind: 'notice', text: 'Allocating a sandbox pod…' } },
        { agentId: 'agent-1', index: 1, event: { kind: 'thinking', text: 'mine is up' } }
      ]) {
        socket.onmessage?.({ data: JSON.stringify({ type: 'output', output: { turnId, ...output } }) })
      }
    })
    act(runFrame)

    expect(getLiveSteps('s1').filter((step) => step.agentId)).toMatchObject([
      { kind: 'notice', agentId: 'agent-2' },
      { kind: 'plan', agentId: 'agent-1', text: 'mine is up' }
    ])
  })

  it('retires the notice when a lane ends cleanly having streamed nothing', async () => {
    const runFrame = captureAnimationFrames()
    const { socket, turnId } = await openStream()

    // A silent AC_NO_RESPONSE decline holds every chunk back: the lane closes with no events.
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: { turnId, agentId: 'agent-1', index: 0, event: { kind: 'notice', text: 'Allocating a sandbox pod…' } }
        })
      })
      socket.onmessage?.({
        data: JSON.stringify({ type: 'done', done: { turnId, agentId: 'agent-1', lastIndex: 0 } })
      })
    })
    act(runFrame)

    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toEqual([])
  })

  it('keeps the notice when the turn fails, where it explains the failure', async () => {
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
          type: 'done',
          done: { turnId, agentId: 'agent-1', lastIndex: 0, error: 'the sandbox never came up' }
        })
      })
    })
    act(runFrame)

    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toMatchObject([
      { kind: 'notice', text: 'Allocating a sandbox pod…' },
      { kind: 'done', text: '⚠️ the sandbox never came up' }
    ])
  })

  it('retires the notice on a streamed session title', async () => {
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
          output: { turnId, agentId: 'agent-1', index: 1, event: { kind: 'session_info', title: 'Skills on hand' } }
        })
      })
    })
    act(runFrame)

    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toEqual([])
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

// #1794 gap 5: the agent's in-band elicitation card is a stream event, and its answer a
// webchat op on the same socket — no CP resource, and the card lives in the transcript.
describe('in-band elicitation cards', () => {
  class ElicitSocket extends StubSocket {
    // The answer rides the SAME socket the card arrived on, so this stub carries the
    // readyState constants `connect`'s reuse check reads.
    static OPEN = 1
    static CLOSED = 3
    static instances: ElicitSocket[] = []
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onerror?: (e: unknown) => void
    onclose?: () => void
    constructor() {
      super()
      ElicitSocket.instances.push(this)
    }
  }

  async function openStream() {
    ElicitSocket.instances = []
    Reflect.set(globalThis, 'WebSocket', ElicitSocket)
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockResolvedValue('wss://relay.test/ws')
    await act(async () => {
      pgSend('s1', 'agent-1', 'hello', 'c1')
    })
    const socket = ElicitSocket.instances[0]!
    await act(async () => {
      socket.readyState = 1
      socket.onopen?.()
    })
    const turn = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { turnId: string }
    return { socket, turnId: turn.turnId }
  }

  function feed(socket: ElicitSocket, turnId: string, index: number, event: unknown, agentId = 'agent-1') {
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'output', output: { turnId, agentId, index, event } })
      })
    })
  }

  function finish(socket: ElicitSocket, turnId: string, lastIndex: number, agentId = 'agent-1') {
    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'done', done: { turnId, agentId, lastIndex } }) })
    })
  }

  const card = (requestId: string) => ({
    kind: 'elicitation',
    requestId,
    message: 'Which branch should I cut from?',
    options: [
      { value: 'main', label: 'main' },
      { value: 'develop', label: 'develop' }
    ]
  })

  it('lands the card as its own live transcript step', async () => {
    const { socket, turnId } = await openStream()
    feed(socket, turnId, 0, card('elicit-1'))
    expect(getLiveSteps('s1').filter((s) => s.kind === 'elicit')).toMatchObject([
      {
        kind: 'elicit',
        text: 'Which branch should I cut from?',
        boundary: true,
        elicit: { requestId: 'elicit-1', options: [{ value: 'main' }, { value: 'develop' }] }
      }
    ])
  })

  it('carries a multi-field form card onto the step, fields and all', async () => {
    const { socket, turnId } = await openStream()
    const fields = [
      {
        propName: 'branch',
        label: 'Base branch',
        kind: 'enum',
        required: true,
        options: [{ value: 'main', label: 'main' }]
      },
      { propName: 'note', label: 'Note', kind: 'text', options: [] }
    ]
    feed(socket, turnId, 0, { ...card('elicit-1'), options: [], fields })
    expect(getLiveSteps('s1').filter((s) => s.kind === 'elicit')).toMatchObject([
      { elicit: { requestId: 'elicit-1', options: [], fields } }
    ])
  })

  it('answers a form card with the whole record over the same socket', async () => {
    const { socket, turnId } = await openStream()
    feed(socket, turnId, 0, card('elicit-1'))
    act(() => pgAnswerElicitation('s1', 'agent-1', 'elicit-1', { branch: 'main', note: 'ok' }, 'c1'))
    await act(async () => {})
    const frames = socket.send.mock.calls.map((call) => JSON.parse(String(call[0])))
    expect(frames.filter((f) => f.type === 'elicitation_choice')).toEqual([
      {
        type: 'elicitation_choice',
        requestId: 'elicit-1',
        value: { branch: 'main', note: 'ok' },
        agentId: 'agent-1'
      }
    ])
  })

  it('settles a card another participant cannot claim: `elicit-<n>` is unique per daemon only', async () => {
    const { socket, turnId } = await openStream()
    feed(socket, turnId, 0, card('elicit-1'))
    // A second participant on a DIFFERENT daemon reuses the id from its own counter.
    // agent-2 streams on its OWN index sequence — cursors are per participant lane.
    feed(
      socket,
      turnId,
      0,
      { kind: 'elicitation_resolved', requestId: 'elicit-1', outcome: 'accepted', label: 'x' },
      'agent-2'
    )
    const held = getLiveSteps('s1').filter((s) => s.kind === 'elicit')
    expect(held).toHaveLength(1)
    expect(held[0]!.elicit).toMatchObject({ requestId: 'elicit-1' })
    expect(held[0]!.elicit?.outcome).toBeUndefined() // still live — the other lane's id is not ours

    feed(socket, turnId, 1, { kind: 'elicitation_resolved', requestId: 'elicit-1', outcome: 'accepted', label: 'main' })
    expect(getLiveSteps('s1').filter((s) => s.kind === 'elicit')).toMatchObject([
      { elicit: { requestId: 'elicit-1', outcome: 'accepted', answerLabel: 'main' } }
    ])
  })

  it("cancels a card the lane's terminal frame overtook, so it cannot stay answerable forever", async () => {
    const { socket, turnId } = await openStream()
    feed(socket, turnId, 0, card('elicit-1'))
    // An interrupt sends `done` before releaseElicits' output reaches the browser, which
    // retires the lane cursor — the settlement that follows is dropped.
    finish(socket, turnId, 0)
    expect(getLiveSteps('s1').filter((s) => s.kind === 'elicit')).toMatchObject([
      { elicit: { requestId: 'elicit-1', outcome: 'cancelled' } }
    ])
  })

  it('settles the card in place on the resolved event, keeping its position', async () => {
    const { socket, turnId } = await openStream()
    feed(socket, turnId, 0, card('elicit-1'))
    feed(socket, turnId, 1, { kind: 'tool_call', toolCallId: 't1', title: 'Read', status: 'pending' })
    feed(socket, turnId, 2, { kind: 'elicitation_resolved', requestId: 'elicit-1', outcome: 'accepted', label: 'main' })
    const steps = getLiveSteps('s1').filter((s) => s.kind === 'elicit' || s.kind === 'tool')
    expect(steps.map((s) => s.kind)).toEqual(['elicit', 'tool']) // settled where it stood
    expect(steps[0]!.elicit).toMatchObject({ outcome: 'accepted', answerLabel: 'main' })

    // A settlement for a card this stream never carried changes nothing.
    feed(socket, turnId, 3, { kind: 'elicitation_resolved', requestId: 'elicit-9', outcome: 'cancelled' })
    expect(getLiveSteps('s1').filter((s) => s.kind === 'elicit')).toHaveLength(1)
  })

  it('records a turn-end cancellation on the card rather than leaving it live', async () => {
    const { socket, turnId } = await openStream()
    feed(socket, turnId, 0, card('elicit-2'))
    feed(socket, turnId, 1, { kind: 'elicitation_resolved', requestId: 'elicit-2', outcome: 'cancelled' })
    expect(getLiveSteps('s1').find((s) => s.kind === 'elicit')?.elicit).toMatchObject({
      outcome: 'cancelled'
    })
  })

  it('answers over the same socket — a chosen value and an explicit Dismiss', async () => {
    const { socket, turnId } = await openStream()
    feed(socket, turnId, 0, card('elicit-1'))
    act(() => pgAnswerElicitation('s1', 'agent-1', 'elicit-1', 'develop', 'c1'))
    act(() => pgAnswerElicitation('s1', 'agent-1', 'elicit-1', null, 'c1'))
    await act(async () => {})
    const frames = socket.send.mock.calls.map((call) => JSON.parse(String(call[0])))
    expect(frames.filter((f) => f.type === 'elicitation_choice')).toEqual([
      { type: 'elicitation_choice', requestId: 'elicit-1', value: 'develop', agentId: 'agent-1' },
      { type: 'elicitation_choice', requestId: 'elicit-1', value: null, agentId: 'agent-1' }
    ])
    // The daemon owns the outcome: nothing settles locally on the send alone.
    expect(getLiveSteps('s1').find((s) => s.kind === 'elicit')?.elicit?.outcome).toBeUndefined()
    expect(ElicitSocket.instances).toHaveLength(1) // one socket, card in and answer out
  })
})

// #547: once the daemon's status frame says the running turn is steerable, a send while it
// streams goes straight to the wire as a steer instead of into the composer's queue.
describe('mid-turn steering', () => {
  class SteerSocket extends StubSocket {
    static instances: SteerSocket[] = []
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onerror?: (e: unknown) => void
    onclose?: () => void
    constructor() {
      super()
      SteerSocket.instances.push(this)
    }
  }

  async function openSteerableStream() {
    SteerSocket.instances = []
    Reflect.set(globalThis, 'WebSocket', SteerSocket)
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockResolvedValue('wss://relay.test/ws')
    await act(async () => {
      pgSend('s1', 'agent-1', 'hello', 'c1')
    })
    const socket = SteerSocket.instances[0]!
    await act(async () => {
      socket.readyState = 1
      socket.onopen?.()
    })
    const turn = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { turnId: string }
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'ack', ack: { accepted: true, turnId: turn.turnId, agentId: 'agent-1' } })
      })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          output: { turnId: turn.turnId, agentId: 'agent-1', index: 0, status: { steerable: true } }
        })
      })
    })
    return { socket, turnId: turn.turnId }
  }
  const frames = (socket: SteerSocket) =>
    socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
  const feed = (socket: SteerSocket, message: unknown) => socket.onmessage?.({ data: JSON.stringify(message) })

  it('restores two refused steers in their send order, ahead of a later queued message', async () => {
    const { socket } = await openSteerableStream()
    await act(async () => {
      expect(pgSend('s1', 'agent-1', 'first steer', 'c1')).toBe(true)
      expect(pgSend('s1', 'agent-1', 'second steer', 'c1')).toBe(true)
    })
    const [a, b] = frames(socket).filter((f) => f.steer === true)
    expect([a!.text, b!.text]).toEqual(['first steer', 'second steer'])
    act(() => {
      feed(socket, { type: 'ack', ack: { accepted: false, turnId: a!.turnId, agentId: 'agent-1', reason: 'busy' } })
    })
    // A later send lands behind the first refusal while the second is still on the wire …
    await act(async () => {
      expect(pgSend('s1', 'agent-1', 'typed after', 'c1')).toBe(true)
    })
    act(() => {
      feed(socket, { type: 'ack', ack: { accepted: false, turnId: b!.turnId, agentId: 'agent-1', reason: 'busy' } })
    })
    // … and the second refusal slots back into ITS place, so the instructions run in the order typed.
    expect(getPgQueue('s1').map((q) => q.text)).toEqual(['first steer', 'second steer', 'typed after'])
  })

  it('lets a tool call that started before a steer complete in the live view', async () => {
    const { socket, turnId } = await openSteerableStream()
    act(() => {
      feed(socket, {
        type: 'output',
        output: {
          turnId,
          agentId: 'agent-1',
          index: 1,
          event: { kind: 'tool_call', toolCallId: 'tc-1', title: 'Run tests', status: 'in_progress' }
        }
      })
    })
    await act(async () => {
      expect(pgSend('s1', 'agent-1', 'also lint', 'c1')).toBe(true)
    })
    act(() => {
      feed(socket, {
        type: 'output',
        output: {
          turnId,
          agentId: 'agent-1',
          index: 2,
          event: { kind: 'tool_update', toolCallId: 'tc-1', status: 'completed' }
        }
      })
    })
    const tool = getLiveSteps('s1').find((s) => s.kind === 'tool' && s.toolCallId === 'tc-1')
    expect(tool).toMatchObject({ toolStatus: 'completed' })
    // The steer still sits between the call and whatever the agent says next.
    const kinds = getLiveSteps('s1').map((s) => (s.steer ? 'steer' : s.kind))
    expect(kinds.indexOf('tool')).toBeLessThan(kinds.indexOf('steer'))
  })

  it('re-sends a steer nobody acked when the socket drops and reconnects', async () => {
    vi.useFakeTimers()
    try {
      const { socket } = await openSteerableStream()
      await act(async () => {
        expect(pgSend('s1', 'agent-1', 'lost on the wire', 'c1')).toBe(true)
      })
      const steer = frames(socket).find((f) => f.steer === true)!
      // The socket dies before the daemon's verdict arrives; the turn is still busy, so the
      // provider reconnects and must put the steer back on the wire under the SAME turnId.
      act(() => socket.onclose?.())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      const reconnected = SteerSocket.instances[1]!
      expect(reconnected).toBeDefined()
      await act(async () => {
        reconnected.readyState = 1
        reconnected.onopen?.()
      })
      act(() => feed(reconnected, { type: 'ready', conversationId: 'c1' }))
      const resent = frames(reconnected).find((f) => f.steer === true)
      expect(resent).toEqual(steer)
      expect(getLiveSteps('s1').find((s) => s.text === 'lost on the wire')).toMatchObject({ steer: true })
      expect(getPgQueue('s1')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an unacked steer under its own turnId when the socket closes on an idle turn', async () => {
    vi.useFakeTimers()
    try {
      const { socket, turnId } = await openSteerableStream()
      await act(async () => {
        expect(pgSend('s1', 'agent-1', 'still unanswered', 'c1')).toBe(true)
      })
      const steer = frames(socket).find((f) => f.steer === true)!
      // The running turn ends (busy clears) and then the socket closes with the steer unacked. The
      // runtime may already have it, so it must NOT become a fresh turn: the provider reconnects for
      // the steer alone and re-sends the same frame, which the daemon reconciles.
      act(() => feed(socket, { type: 'done', done: { turnId, agentId: 'agent-1', stopReason: 'end_turn' } }))
      act(() => socket.onclose?.())
      expect(getPgQueue('s1')).toEqual([])
      expect(getLiveSteps('s1').filter((s) => s.text === 'still unanswered')).toMatchObject([{ steer: true }])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      const reconnected = SteerSocket.instances[1]!
      expect(reconnected).toBeDefined()
      await act(async () => {
        reconnected.readyState = 1
        reconnected.onopen?.()
      })
      act(() => feed(reconnected, { type: 'ready', conversationId: 'c1' }))
      expect(frames(reconnected).find((f) => f.steer === true)).toEqual(steer)
      // The daemon had run it as its own turn (the turn was over): the copy is reported accepted, the
      // step becomes an ordinary user turn and the browser opens its lane and pulls the replay.
      act(() => feed(reconnected, { type: 'ack', ack: { accepted: true, turnId: steer.turnId, agentId: 'agent-1' } }))
      expect(getLiveSteps('s1').filter((s) => s.text === 'still unanswered')).toMatchObject([{ steer: undefined }])
      expect(frames(reconnected).find((f) => f.type === 'resume')).toMatchObject({ turnId: steer.turnId })
      expect(getPgQueue('s1')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens and resumes a late steer whose accepted ack outran the older turn’s replayed done', async () => {
    vi.useFakeTimers()
    try {
      const { socket, turnId } = await openSteerableStream()
      await act(async () => {
        expect(pgSend('s1', 'agent-1', 'late steer', 'c1')).toBe(true)
      })
      const steer = frames(socket).find((f) => f.steer === true)!
      // The socket drops while the first turn still streams here; daemon-side that turn ends and
      // the steer is admitted as its own turn before the browser reconnects.
      act(() => socket.onclose?.())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      const reconnected = SteerSocket.instances[1]!
      await act(async () => {
        reconnected.readyState = 1
        reconnected.onopen?.()
      })
      act(() => feed(reconnected, { type: 'ready', conversationId: 'c1' }))
      expect(frames(reconnected).find((f) => f.steer === true)).toEqual(steer)
      // The copy's plain accepted ack arrives BEFORE the older turn's replayed done.
      act(() => feed(reconnected, { type: 'ack', ack: { accepted: true, turnId: steer.turnId, agentId: 'agent-1' } }))
      expect(frames(reconnected).filter((f) => f.type === 'resume' && f.turnId === steer.turnId)).toEqual([])
      act(() => feed(reconnected, { type: 'done', done: { turnId, agentId: 'agent-1', stopReason: 'end_turn' } }))
      // Retiring the older lane hands over to the late turn: its lane opens and is resumed, and the
      // message reads as an ordinary turn — the reply will stream into this connection.
      expect(frames(reconnected).find((f) => f.type === 'resume' && f.turnId === steer.turnId)).toMatchObject({
        turnId: steer.turnId,
        agentId: 'agent-1'
      })
      expect(getLiveSteps('s1').filter((s) => s.text === 'late steer')).toMatchObject([{ steer: undefined }])
      expect(getPgQueue('s1')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not requeue an unacked steer when reconnecting gives up — the delivery is marked uncertain', async () => {
    vi.useFakeTimers()
    try {
      const { socket } = await openSteerableStream()
      await act(async () => {
        expect(pgSend('s1', 'agent-1', 'maybe delivered', 'c1')).toBe(true)
      })
      act(() => socket.onclose?.())
      // Every reconnect attempt dies at once until the budget is spent.
      for (let attempt = 0; attempt < 8; attempt++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000)
        })
        const latest = SteerSocket.instances.at(-1)!
        if (latest !== socket && latest.readyState === 0) act(() => latest.onclose?.())
      }
      expect(getPgQueue('s1')).toEqual([])
      expect(getLiveSteps('s1').filter((s) => s.text === 'maybe delivered')).toMatchObject([{ steer: true }])
      expect(getLiveSteps('s1').some((s) => s.kind === 'done' && s.text.includes('Could not confirm'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('steers a follow-up into the running turn instead of queueing it', async () => {
    const { socket, turnId } = await openSteerableStream()
    await act(async () => {
      expect(pgSend('s1', 'agent-1', 'use staging instead', 'c1')).toBe(true)
    })
    expect(getPgQueue('s1')).toEqual([])
    const steer = frames(socket).find((f) => f.steer === true)
    expect(steer).toMatchObject({ text: 'use staging instead', steer: true })
    expect(steer!.turnId).not.toBe(turnId)
    const step = getLiveSteps('s1').find((s) => s.text === 'use staging instead')
    expect(step).toMatchObject({ kind: 'msg', who: '@you', steer: true })

    // The daemon steered it: its own stream ends at once and the first turn keeps streaming —
    // a further send is still a steer, not a fresh turn.
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'ack',
          ack: { accepted: true, turnId: steer!.turnId, agentId: 'agent-1', steered: true }
        })
      })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'done',
          done: { turnId: steer!.turnId, agentId: 'agent-1', stopReason: 'steered_into_turn' }
        })
      })
    })
    expect(getLiveSteps('s1').find((s) => s.text === 'use staging instead')).toMatchObject({ steer: true })
    await act(async () => {
      expect(pgSend('s1', 'agent-1', 'and skip the migration', 'c1')).toBe(true)
    })
    expect(frames(socket).filter((f) => f.steer === true)).toHaveLength(2)
    expect(getPgQueue('s1')).toEqual([])
  })

  it('puts a steer the daemon refused back at the head of the queue', async () => {
    const { socket } = await openSteerableStream()
    await act(async () => {
      expect(pgSend('s1', 'agent-1', 'declined steer', 'c1')).toBe(true)
    })
    const steer = frames(socket).find((f) => f.steer === true)!
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'ack',
          ack: { accepted: false, turnId: steer.turnId, agentId: 'agent-1', reason: 'busy' }
        })
      })
    })
    expect(getPgQueue('s1').map((q) => q.text)).toEqual(['declined steer'])
    expect(getLiveSteps('s1').some((s) => s.text === 'declined steer')).toBe(false)
    // With something already queued, the next send waits behind it — FIFO beats steering.
    await act(async () => {
      expect(pgSend('s1', 'agent-1', 'after it', 'c1')).toBe(true)
    })
    expect(getPgQueue('s1').map((q) => q.text)).toEqual(['declined steer', 'after it'])
    expect(frames(socket).filter((f) => f.steer === true)).toHaveLength(1)
  })

  it('keeps queueing while the daemon has not declared the turn steerable', async () => {
    SteerSocket.instances = []
    Reflect.set(globalThis, 'WebSocket', SteerSocket)
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockResolvedValue('wss://relay.test/ws')
    await act(async () => {
      pgSend('s1', 'agent-1', 'hello', 'c1')
    })
    const socket = SteerSocket.instances[0]!
    await act(async () => {
      socket.readyState = 1
      socket.onopen?.()
    })
    await act(async () => {
      expect(pgSend('s1', 'agent-1', 'queued as before', 'c1')).toBe(true)
    })
    expect(getPgQueue('s1').map((q) => q.text)).toEqual(['queued as before'])
    expect(frames(socket).some((f) => f.steer === true)).toBe(false)
  })
})

// The first send of a fresh playground rides the socket `openPlayground` warmed seconds earlier —
// connect() hands a still-CONNECTING one straight to the turn — so a dial that dies in the browser
// (one that never reaches the relay at all) used to lose exactly the message that opens a
// conversation, and the retry the reader typed by hand started a SECOND conversation blind to it.
describe('a dial that dies before the turn reaches the socket', () => {
  class DyingSocket extends StubSocket {
    static instances: DyingSocket[] = []
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onerror?: (e: unknown) => void
    onclose?: (() => void) | null
    constructor() {
      super()
      DyingSocket.instances.push(this)
    }
  }
  /** Let a rebuild settle: its socket is two promises deep (mint, then dial). */
  const settle = () => act(async () => {})

  beforeEach(async () => {
    DyingSocket.instances = []
    Reflect.set(globalThis, 'WebSocket', DyingSocket)
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockResolvedValue('wss://relay.test/ws')
  })

  it('rebuilds once and puts the SAME turn on the fresh socket', async () => {
    await act(async () => {
      pgSend('s1', 'agent-1', 'hello')
    })
    await act(async () => {
      DyingSocket.instances[0]!.onerror?.({})
    })
    await settle()
    expect(DyingSocket.instances).toHaveLength(2)
    const live = DyingSocket.instances[1]!
    await act(async () => {
      live.readyState = 1
      live.onopen?.()
    })
    const turnId = getLiveSteps('s1').find((s) => s.text === 'hello')?.turnId
    expect(JSON.parse(String(live.send.mock.calls[0]?.[0]))).toMatchObject({ text: 'hello', turnId })
    expect(getLiveSteps('s1').some((s) => String(s.text).includes('Could not reach the agent'))).toBe(false)
  })

  it('reports the turn unsent when the rebuilt dial dies too', async () => {
    await act(async () => {
      pgSend('s1', 'agent-1', 'hello')
    })
    await act(async () => {
      DyingSocket.instances[0]!.onerror?.({})
    })
    await settle()
    await act(async () => {
      DyingSocket.instances[1]!.onerror?.({})
    })
    await settle()
    expect(DyingSocket.instances).toHaveLength(2)
    expect(getLiveSteps('s1').some((s) => String(s.text).includes('Could not reach the agent'))).toBe(true)
  })

  it('does not rebuild on a CP verdict — a refusal is an answer, not a blip', async () => {
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockRejectedValue(new api.ApiError('webchat relay pool not configured', 503))
    await act(async () => {
      pgSend('s1', 'agent-1', 'hello')
    })
    await settle()
    expect(vi.mocked(api.webchatWsUrl)).toHaveBeenCalledTimes(1)
    expect(getLiveSteps('s1').some((s) => String(s.text).includes('Webchat relay not configured'))).toBe(true)
  })
})

describe('MCP App card lifetime (webchat-mcp-apps.md §7.3)', () => {
  class AppSocket extends StubSocket {
    static instances: AppSocket[] = []
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onerror?: (e: unknown) => void
    onclose?: () => void
    constructor() {
      super()
      AppSocket.instances.push(this)
    }
  }

  async function openStream() {
    AppSocket.instances = []
    Reflect.set(globalThis, 'WebSocket', AppSocket)
    const api = await import('@/lib/api')
    vi.mocked(api.webchatWsUrl).mockResolvedValue('wss://relay.test/ws')
    await act(async () => {
      pgSend('s1', 'agent-1', 'open the chooser', 'c1')
    })
    const socket = AppSocket.instances[0]!
    await act(async () => {
      socket.readyState = 1
      socket.onopen?.()
    })
    const turn = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0])) as { turnId: string }
    return { socket, turnId: turn.turnId }
  }

  const CARD = {
    kind: 'app',
    appId: 'app-1',
    title: 'Deploy target',
    toolName: 'charts__pick_target',
    html: '<p>frame</p>'
  }

  function send(socket: AppSocket, turnId: string, index: number, event: unknown): void {
    socket.onmessage?.({
      data: JSON.stringify({ type: 'output', output: { turnId, agentId: 'agent-1', index, event } })
    })
  }

  it('stands the card in the transcript with a boundary, so the reply after it starts fresh', async () => {
    const { socket, turnId } = await openStream()
    act(() => send(socket, turnId, 0, CARD))
    expect(getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')).toMatchObject([
      { kind: 'app', boundary: true, app: { appId: 'app-1', title: 'Deploy target' } }
    ])
  })

  it('settles a card AFTER its opening turn has finished — a frame outlives the turn cursor', async () => {
    const { socket, turnId } = await openStream()
    act(() => send(socket, turnId, 0, CARD))
    // The turn ends. Its cursor is retired and its lane refuses to reopen, which is exactly the
    // state in which the reader is still looking at the frame and its bridge is still served.
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'done', done: { turnId, agentId: 'agent-1' } }) })
    })
    // The daemon settles the card on the card's ORIGINAL turnId. Dropping this would leave a
    // closed frame rendering as live forever.
    act(() => send(socket, turnId, 1, { kind: 'app_resolved', appId: 'app-1', outcome: 'closed' }))
    const steps = getLiveSteps('s1').filter((step) => step.kind === 'app')
    expect(steps).toMatchObject([{ app: { appId: 'app-1', outcome: 'closed' } }])
    // The template goes with the settlement: a settled frame is never re-armed.
    expect(steps[0]?.app?.html).toBeUndefined()
  })

  it('completes a view RPC issued after the turn finished, instead of letting it time out', async () => {
    const { socket, turnId } = await openStream()
    act(() => send(socket, turnId, 0, CARD))
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'done', done: { turnId, agentId: 'agent-1' } }) })
    })

    let settled: unknown
    await act(async () => {
      void pgAppRpc('s1', 'agent-1', 'app-1', { method: 'tools/call', name: 'refresh' }, 'c1').then((outcome) => {
        settled = outcome
      })
    })
    // The browser-minted callId is what correlates the answer; read it off the wire.
    const sent = socket.send.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { type?: string; callId?: string })
      .find((frame) => frame.type === 'app_rpc')
    expect(sent?.callId).toBeTypeOf('string')

    await act(async () => {
      send(socket, turnId, 1, {
        kind: 'app_rpc_result',
        appId: 'app-1',
        callId: sent!.callId,
        outcome: { ok: true, result: { structuredContent: { rows: [1] } } }
      })
    })
    await act(async () => undefined)
    expect(settled).toEqual({ ok: true, result: { structuredContent: { rows: [1] } } })
  })

  it('keeps the ordered cursor intact when an app event lands MID-turn, so the turn still ends', async () => {
    const { socket, turnId } = await openStream()
    // The bot's sequence: app(0) → app_rpc_result(1) → message(2) → done(lastIndex: 2). Applying
    // index 1 out of band would consume it without telling the cursor, which then waits for it
    // forever — the reply text and `done` stay buffered and the conversation is wedged busy.
    act(() => {
      send(socket, turnId, 0, CARD)
      send(socket, turnId, 1, {
        kind: 'app_rpc_result',
        appId: 'app-1',
        callId: 'mid-turn',
        outcome: { ok: true, result: {} }
      })
      send(socket, turnId, 2, { kind: 'message', text: 'picked prod' })
    })
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'done', done: { turnId, agentId: 'agent-1', lastIndex: 2 } })
      })
    })
    // The reply after the app event committed, and the turn is no longer busy.
    const steps = getLiveSteps('s1').filter((step) => step.agentId === 'agent-1')
    expect(steps.map((step) => step.kind)).toEqual(['app', 'done'])
    expect(steps.at(-1)).toMatchObject({ text: 'picked prod' })
  })

  it('drops an RPC answer nobody is waiting for, so a replayed stream is harmless', async () => {
    const { socket, turnId } = await openStream()
    act(() => send(socket, turnId, 0, CARD))
    act(() =>
      send(socket, turnId, 1, {
        kind: 'app_rpc_result',
        appId: 'app-1',
        callId: 'never-asked',
        outcome: { ok: true, result: {} }
      })
    )
    // No throw, and no transcript row: an answer to nothing is not an event the reader sees.
    expect(getLiveSteps('s1').filter((step) => step.kind === 'app')).toHaveLength(1)
  })
})
