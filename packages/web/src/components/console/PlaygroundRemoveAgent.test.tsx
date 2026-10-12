// @vitest-environment happy-dom
// Removing a member from a live playground conversation (webchat-multi-agents.md §3.1a).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

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
  fetchSessionMessages: vi.fn(async () => ({ messages: [] })),
  removeWebchatConversationAgent: vi.fn(async () => ({ participants: [] })),
  webchatWsUrl: vi.fn(async () => 'wss://relay.test/ws'),
  webchatSessionWsUrl: vi.fn(async () => 'wss://relay.test/session')
}))

const api = await import('@/lib/api')
const { PlaygroundProvider, usePlayground } = await import('./PlaygroundProvider')

class StubSocket {
  static CONNECTING = 0
  static OPEN = 1
  readyState = 0
  send = vi.fn()
  close = vi.fn()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

let pg: ReturnType<typeof usePlayground>
function Probe() {
  pg = usePlayground()
  return null
}

const primary = { id: 'agent-a', name: 'Primary' } as unknown as Agent
const member = { id: 'agent-b', name: 'Helper' } as unknown as Agent

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

const rosterOf = (id: string) => pg.getPgSession(id)?.participants?.map((p) => p.agentId)

describe('pgRemoveAgent', () => {
  it('removes a member through the CP and shrinks the roster', async () => {
    let id = ''
    act(() => {
      id = pg.openPlayground(primary, [member])
    })
    act(() => pg.pgAttach(id, primary.id, 'c1'))
    let ok = false
    await act(async () => {
      ok = await pg.pgRemoveAgent(id, member.id)
    })
    expect(ok).toBe(true)
    expect(api.removeWebchatConversationAgent).toHaveBeenCalledWith('org1', 'c1', member.id)
    expect(rosterOf(id)).toEqual([primary.id])
  })

  it('refuses the primary without calling the CP', async () => {
    let id = ''
    act(() => {
      id = pg.openPlayground(primary, [member])
    })
    let ok = true
    await act(async () => {
      ok = await pg.pgRemoveAgent(id, primary.id)
    })
    expect(ok).toBe(false)
    expect(api.removeWebchatConversationAgent).not.toHaveBeenCalled()
    expect(rosterOf(id)).toEqual([primary.id, member.id])
  })

  it('keeps the roster and reports the error when the CP refuses', async () => {
    vi.mocked(api.removeWebchatConversationAgent).mockRejectedValueOnce(
      new api.ApiError('cannot remove the primary agent', 409)
    )
    let id = ''
    act(() => {
      id = pg.openPlayground(primary, [member])
    })
    act(() => pg.pgAttach(id, primary.id, 'c1'))
    let ok = true
    await act(async () => {
      ok = await pg.pgRemoveAgent(id, member.id)
    })
    expect(ok).toBe(false)
    expect(rosterOf(id)).toEqual([primary.id, member.id])
    expect(pg.getPgSession(id)?.steps.at(-1)).toMatchObject({ text: '⚠️ cannot remove the primary agent' })
  })
})
