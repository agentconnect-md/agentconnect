// @vitest-environment happy-dom
//
// The single-session tail passes reconcile only the rows it just fetched, and skips reconcile while
// the turn is busy. A fetch that returns AFTER the user sent the next turn therefore moved the cursor
// past a persisted prompt row nobody reconciled; the live echo of that prompt then survived every
// later tail and rendered a second time below the transcript. Those rows must ride along on the
// next reconcile instead.
import { act, useEffect, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionHistoryDto, SessionMessageDto } from '@/lib/api'

vi.mock('@/components/console/platforms/registry', () => ({ platformTranscriptOrdering: () => 'seq' }))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message)
    }
  },
  fetchSessionMessages: vi.fn()
}))

const { fetchSessionMessages } = await import('@/lib/api')
const { useSessionTranscript } = await import('./use-session-transcript')
const fetchMock = vi.mocked(fetchSessionMessages)

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  fetchMock.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function page(messages: SessionMessageDto[], liveCursor: string): SessionHistoryDto {
  return { sessionId: 's1', messages, nextCursor: null, liveCursor, liveMore: false }
}

function row(seq: number, sender: string, text: string): SessionMessageDto {
  return { seq, sender, text, ts: String(1_784_098_800_000 + seq), kind: 'text' }
}

/** One fetch the test settles by hand, so it can flip the busy flag while the request is in flight. */
function deferredPage(): { promise: Promise<SessionHistoryDto>; resolve: (page: SessionHistoryDto) => void } {
  let resolve!: (page: SessionHistoryDto) => void
  const promise = new Promise<SessionHistoryDto>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const flush = () => act(async () => {})

function Harness({
  busyRef,
  reconcile,
  expose,
  conversation = false
}: {
  busyRef: RefObject<boolean>
  reconcile: (id: string, persisted: SessionMessageDto[], agentId: string) => void
  expose: (refreshTail: () => Promise<void>) => void
  conversation?: boolean
}) {
  const { refreshTail } = useSessionTranscript({
    sid: 's1',
    aid: 'agent',
    wantTranscript: true,
    sessionPlatform: 'webchat',
    conversationKey: conversation ? 'c1' : null,
    conversationSourceKey: conversation ? 's1' : '',
    conversationMembers: conversation ? [{ sessionId: 's1', agentId: 'agent' }] : null,
    conversationRosterPlatform: conversation ? 'webchat' : undefined,
    sessionBusyRef: busyRef,
    reconcileLiveSteps: reconcile
  })
  useEffect(() => expose(refreshTail), [expose, refreshTail])
  return null
}

describe('useSessionTranscript single-session tail', () => {
  it('carries rows fetched under a busy turn into the next reconcile', async () => {
    const busyRef = { current: false }
    const reconcile = vi.fn()
    let refreshTail: () => Promise<void> = () => Promise.resolve()
    const expose = (fn: () => Promise<void>) => {
      refreshTail = fn
    }

    fetchMock.mockResolvedValueOnce(page([], 'c0'))
    await act(async () => root.render(<Harness busyRef={busyRef} reconcile={reconcile} expose={expose} />))
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(1)
    reconcile.mockClear()

    // Tail 1 starts idle; the user sends "retry" while it is in flight, and the page it returns already
    // holds the persisted prompt row.
    const inFlight = deferredPage()
    fetchMock.mockReturnValueOnce(inFlight.promise)
    const tail1 = refreshTail()
    busyRef.current = true
    const retry = row(1, 'user', 'retry')
    inFlight.resolve(page([retry], 'c1'))
    await act(async () => tail1)
    expect(reconcile).not.toHaveBeenCalled()

    // The turn ends; tail 2 reads strictly after the moved cursor, so "retry" never comes back on its own.
    busyRef.current = false
    const reply = row(2, 'agent', 'done')
    fetchMock.mockResolvedValueOnce(page([reply], 'c2'))
    await act(async () => refreshTail())
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ after: 'c1' })
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile.mock.calls[0]?.[1]).toEqual([retry, reply])

    // Once handed over, the carried rows are gone: the next idle tail reconciles its own increment only.
    fetchMock.mockResolvedValueOnce(page([row(3, 'agent', 'more')], 'c3'))
    await act(async () => refreshTail())
    expect(reconcile.mock.calls[1]?.[1].map((m: SessionMessageDto) => m.seq)).toEqual([3])
  })
})

describe('useSessionTranscript conversation tail', () => {
  it('reconciles saved history after a silent turn even when the tail has no new rows', async () => {
    const busyRef = { current: true }
    const reconcile = vi.fn()
    let refreshTail: () => Promise<void> = () => Promise.resolve()
    const saved = row(1, 'user', 'inspect')
    fetchMock.mockResolvedValueOnce(page([saved], 'c1'))
    await act(async () =>
      root.render(<Harness busyRef={busyRef} reconcile={reconcile} expose={(fn) => (refreshTail = fn)} conversation />)
    )
    await flush()
    expect(reconcile).not.toHaveBeenCalled()

    busyRef.current = false
    fetchMock.mockResolvedValueOnce(page([], 'c1'))
    await act(async () => refreshTail())
    expect(reconcile).toHaveBeenCalledWith('s1', [saved], 'agent', [saved])
  })
})

describe('useSessionTranscript prompt confirmation across members', () => {
  function MembersHarness({
    reconcile,
    promptSessionIds
  }: {
    reconcile: (id: string, persisted: SessionMessageDto[], agentId: string, promptRows?: SessionMessageDto[]) => void
    promptSessionIds: string[]
  }) {
    useSessionTranscript({
      sid: 's1',
      aid: 'agent',
      wantTranscript: true,
      sessionPlatform: 'webchat',
      conversationKey: 'c1',
      conversationSourceKey: 's1,s2',
      conversationMembers: [
        { sessionId: 's1', agentId: 'agent' },
        { sessionId: 's2', agentId: 'reviewer' }
      ],
      conversationRosterPlatform: 'webchat',
      sessionBusyRef: { current: false },
      promptSessionIds,
      reconcileLiveSteps: reconcile
    })
    return null
  }

  it('confirms a prompt saved in a member the page sent to earlier, not only the current pick', async () => {
    const reconcile = vi.fn()
    const sentToReviewer = row(1, 'user', 'please re-review')
    fetchMock.mockImplementation(async (sessionId: string) =>
      sessionId === 's2' ? page([sentToReviewer], 'c-s2') : page([], 'c-s1')
    )
    // The reader sent to s2, then picked s1 again before the fetch settled.
    await act(async () => root.render(<MembersHarness reconcile={reconcile} promptSessionIds={['s2', 's1']} />))
    await flush()

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile.mock.calls[0]?.[3]).toEqual([sentToReviewer])
  })

  it('keeps fuzzy prompt matching to the representative when the page sent nowhere else', async () => {
    const reconcile = vi.fn()
    const peerRow = row(1, 'user', 'please re-review')
    fetchMock.mockImplementation(async (sessionId: string) =>
      sessionId === 's2' ? page([peerRow], 'c-s2') : page([], 'c-s1')
    )
    await act(async () => root.render(<MembersHarness reconcile={reconcile} promptSessionIds={['s1']} />))
    await flush()

    expect(reconcile.mock.calls[0]?.[3]).toEqual([])
  })
})
