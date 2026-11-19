// @vitest-environment happy-dom
// The transcript tail reads mid-turn, spaces its reads, and hands reconcile every row it has read (webchat-transcript-refresh.md §4).
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionHistoryDto, SessionMessageDto } from '@/lib/api'
import type { LiveRetireRead } from '@/lib/session-transcript'

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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  fetchMock.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const pastGap = () => act(async () => vi.advanceTimersByTimeAsync(1_000))

function page(messages: SessionMessageDto[], liveCursor: string): SessionHistoryDto {
  return { sessionId: 's1', messages, nextCursor: null, liveCursor, liveMore: false }
}

function row(seq: number, sender: string, text: string): SessionMessageDto {
  return { seq, sender, text, ts: String(1_784_098_800_000 + seq), kind: 'text' }
}

const flush = () => act(async () => {})

function Harness({
  reconcile,
  expose,
  conversation = false
}: {
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
    reconcileLiveSteps: reconcile
  })
  useEffect(() => expose(refreshTail), [expose, refreshTail])
  return null
}

describe('useSessionTranscript single-session tail', () => {
  async function open(reconcile: (id: string, persisted: SessionMessageDto[], agentId: string) => void) {
    let refreshTail: () => Promise<void> = () => Promise.resolve()
    fetchMock.mockResolvedValueOnce(page([], 'c0'))
    await act(async () => root.render(<Harness reconcile={reconcile} expose={(fn) => (refreshTail = fn)} />))
    await flush()
    return () => refreshTail()
  }

  it('reads mid-turn and hands reconcile every row read so far, with its own increment and when the read began', async () => {
    const reconcile = vi.fn()
    const tail = await open(reconcile)
    expect(reconcile).toHaveBeenCalledTimes(1)
    const retry = row(1, 'user', 'retry')
    fetchMock.mockResolvedValueOnce(page([retry], 'c1'))
    const began = Date.now()
    await act(async () => tail())
    expect(reconcile.mock.calls[1]).toEqual(['s1', [retry], 'agent', { promptRows: [retry], readStartedAtMs: began }])
    // A copy named after its row was read still finds that row on the next read.
    await pastGap()
    const reply = row(2, 'agent', 'done')
    fetchMock.mockResolvedValueOnce(page([reply], 'c2'))
    await act(async () => tail())
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ after: 'c1' })
    expect(reconcile.mock.calls[2]?.[1]).toEqual([retry, reply])
    expect(reconcile.mock.calls[2]?.[3]).toMatchObject({ promptRows: [reply] })
  })

  it('reads at most once a gap, and once more at its end for a signal inside it', async () => {
    const reconcile = vi.fn()
    const tail = await open(reconcile)
    fetchMock.mockResolvedValue(page([], 'c1'))
    await act(async () => tail())
    await act(async () => tail())
    await act(async () => tail())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await pastGap()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reads nothing while the page is hidden', async () => {
    const reconcile = vi.fn()
    const tail = await open(reconcile)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    try {
      await act(async () => tail())
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    }
  })
})

describe('useSessionTranscript conversation tail', () => {
  it('reconciles saved history on every read, a read with no new rows included', async () => {
    const reconcile = vi.fn()
    let refreshTail: () => Promise<void> = () => Promise.resolve()
    const saved = row(1, 'user', 'inspect')
    fetchMock.mockResolvedValueOnce(page([saved], 'c1'))
    await act(async () =>
      root.render(<Harness reconcile={reconcile} expose={(fn) => (refreshTail = fn)} conversation />)
    )
    await flush()
    expect(reconcile).toHaveBeenCalledTimes(1)

    fetchMock.mockResolvedValueOnce(page([], 'c1'))
    await act(async () => refreshTail())
    expect(reconcile).toHaveBeenLastCalledWith('s1', [saved], 'agent', {
      promptRows: [saved],
      readStartedAtMs: expect.any(Number)
    })
  })
})

describe('useSessionTranscript prompt confirmation across members', () => {
  function MembersHarness({
    reconcile,
    promptSessionIds
  }: {
    reconcile: (id: string, persisted: SessionMessageDto[], agentId: string, read?: LiveRetireRead) => void
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
    expect(reconcile.mock.calls[0]?.[3]).toMatchObject({ promptRows: [sentToReviewer] })
  })

  it('keeps fuzzy prompt matching to the representative when the page sent nowhere else', async () => {
    const reconcile = vi.fn()
    const peerRow = row(1, 'user', 'please re-review')
    fetchMock.mockImplementation(async (sessionId: string) =>
      sessionId === 's2' ? page([peerRow], 'c-s2') : page([], 'c-s1')
    )
    await act(async () => root.render(<MembersHarness reconcile={reconcile} promptSessionIds={['s1']} />))
    await flush()

    expect(reconcile.mock.calls[0]?.[3]).toMatchObject({ promptRows: [] })
  })
})

describe('useSessionTranscript roots view (webchat-threads.md §6.1)', () => {
  type Seen = {
    threadsView: boolean
    threads: ReadonlyMap<string, { replies: number }>
    refreshTail: () => Promise<void>
  }
  const reconcile = () => {}
  function RootsHarness({ expose }: { expose: (seen: Seen) => void }) {
    const { threadsView, threads, refreshTail } = useSessionTranscript({
      sid: 's1',
      aid: 'agent',
      wantTranscript: true,
      sessionPlatform: 'webchat',
      conversationKey: null,
      conversationSourceKey: '',
      conversationMembers: null,
      conversationRosterPlatform: undefined,
      rootsView: true,
      reconcileLiveSteps: reconcile
    })
    useEffect(() => {
      expose({ threadsView, threads, refreshTail })
    })
    return null
  }
  const footer = (rootId: string, replies: number) => ({ rootId, replies, participants: [], readable: true })

  it('reads roots with their threads’ footers, the newest footer of each thread winning', async () => {
    fetchMock
      .mockResolvedValueOnce({ ...page([row(1, 'user', 'plan the release')], 'c1'), threads: [footer('a', 1)] })
      .mockResolvedValueOnce({ ...page([], 'c2'), threads: [footer('a', 2), footer('b', 1)] })
    let seen!: Seen
    await act(async () => root.render(<RootsHarness expose={(next) => (seen = next)} />))
    await flush()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ view: 'roots' })
    expect(seen.threadsView).toBe(true)
    expect(seen.threads.get('a')?.replies).toBe(1)
    await act(async () => seen.refreshTail())
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ view: 'roots', after: 'c1' })
    expect(seen.threads.get('a')?.replies).toBe(2)
    expect(seen.threads.get('b')?.replies).toBe(1)
  })

  it('reads the flat view from a daemon without thread reads, and keeps reading it', async () => {
    const { ApiError } = await import('@/lib/api')
    const missing = Object.assign(new ApiError('feature missing', 409), { code: 'DAEMON_FEATURE_MISSING' })
    fetchMock
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(page([row(1, 'user', 'plan the release')], 'c1'))
      .mockResolvedValueOnce(page([], 'c2'))
    let seen!: Seen
    await act(async () => root.render(<RootsHarness expose={(next) => (seen = next)} />))
    await flush()
    expect(seen.threadsView).toBe(false)
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty('view')
    await act(async () => seen.refreshTail())
    expect(fetchMock.mock.calls[2]?.[1]).not.toHaveProperty('view')
    expect(seen.threads.size).toBe(0)
  })
})
