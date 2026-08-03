// @vitest-environment happy-dom
//
// `pgSend` reports whether a send was ACCEPTED, and SessionDetailView's composer
// relies on that to decide whether to pin the transcript to the bottom. Enter on
// an empty composer, or Enter while a turn is already streaming, must report
// rejection — otherwise a reader who scrolled up into history gets yanked to the
// bottom for a send that never happened. Both the textarea Enter path and the
// send button route through the same `onPgSend`, so pinning this one condition
// keeps the two entry points aligned.
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

function Probe() {
  const pg = usePlayground()
  pgSend = pg.pgSend
  openPlayground = pg.openPlayground
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

  // The busy flag is React state, so the second Enter only sees it after a
  // re-render — which is exactly the real ordering: two keypresses are two events
  // with a commit in between. `act` flushes that commit and the probe hands back
  // the fresh closure.
  it('rejects a second send while the first turn is still streaming', () => {
    act(() => {
      expect(pgSend('s1', 'a1', 'hello')).toBe(true)
    })
    expect(pgSend('s1', 'a1', 'again')).toBe(false) // busy
  })

  it('keeps the busy rejection per session', () => {
    act(() => {
      expect(pgSend('s1', 'a1', 'hello')).toBe(true)
    })
    expect(pgSend('s2', 'a1', 'hello')).toBe(true) // a different session is free
  })

  // openPlayground exists on the same context; touching it here documents that the
  // probe wiring is real and not a partially-mocked stand-in.
  it('exposes the real provider surface', () => {
    expect(typeof openPlayground).toBe('function')
  })
})
