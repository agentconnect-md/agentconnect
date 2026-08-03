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
  webchatSocketUrl: () => 'wss://relay.test/ws'
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

function Probe() {
  const pg = usePlayground()
  pgSend = pg.pgSend
  openPlayground = pg.openPlayground
  getPgQueue = pg.getPgQueue
  pgCancelQueued = pg.pgCancelQueued
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

  // openPlayground exists on the same context; touching it here documents that the
  // probe wiring is real and not a partially-mocked stand-in.
  it('exposes the real provider surface', () => {
    expect(typeof openPlayground).toBe('function')
  })
})
