// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MemoryEntryCapabilities } from '@agentconnect.md/protocol'
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: string
    ) {
      super(message)
    }
  }
  return {
    ApiError,
    describeAgentMemoryEntries: vi.fn(),
    listAgentMemoryEntries: vi.fn(),
    getAgentMemoryEntry: vi.fn(),
    searchAgentMemoryEntries: vi.fn(),
    listAgentMemoryEntryHistory: vi.fn(),
    wakeAgent: vi.fn(async () => ({ state: 'starting' })),
    createAgentMemoryEntry: vi.fn(),
    updateAgentMemoryEntry: vi.fn(),
    deleteAgentMemoryEntry: vi.fn()
  }
})
// The lazy Markdown view renders as a marked stub; its own behavior is covered by MarkdownView tests.
vi.mock('next/dynamic', () => ({
  default:
    () =>
    (props: {
      content: string
      resolveLink?: (href: string) => { kind: string; onActivate?: () => void } | undefined
    }) => (
      <div data-testid="markdown">
        {props.content}
        <button type="button" onClick={() => props.resolveLink?.('oncall.md')?.onActivate?.()}>
          follow oncall.md
        </button>
        <span data-testid="stray">{props.resolveLink?.('stray.md')?.kind}</span>
      </div>
    )
}))
import * as api from '@/lib/api'
import { UnifiedMemoryPanel } from './UnifiedMemoryPanel'
const entry = {
  ref: 'opaque-ref',
  label: 'Topic',
  revision: 'r1',
  byteSize: 8,
  format: 'markdown' as const,
  origin: 'active' as const,
  editable: true
}
const caps: MemoryEntryCapabilities = {
  version: 1,
  operations: ['list', 'get', 'create', 'update', 'delete'],
  supportedScopes: ['agent', 'channel'],
  writeConsistency: 'conditional',
  exactCreate: true,
  exactEdit: true,
  enumeration: 'live',
  graph: false,
  limits: { maxItemBytes: 256000, maxPageItems: 100, maxMutationRequestBytes: 196608 }
}
let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.mocked(api.describeAgentMemoryEntries).mockResolvedValue(caps)
  vi.mocked(api.listAgentMemoryEntries).mockResolvedValue({ entries: [entry], consistency: 'live', order: 'topic' })
  vi.mocked(api.getAgentMemoryEntry).mockResolvedValue({ entry, text: 'headtail', complete: true })
  vi.mocked(api.updateAgentMemoryEntry).mockResolvedValue({ operationId: 'op', state: 'completed' })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function render(channelKey = 'one', canEdit = true) {
  await act(async () => root.render(<UnifiedMemoryPanel agentId="agent" channelKey={channelKey} canEdit={canEdit} />))
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}
it('reads all slices and submits the original revision/ref in a conditional update', async () => {
  vi.mocked(api.getAgentMemoryEntry)
    .mockResolvedValueOnce({ entry, text: 'head', complete: false, nextContentCursor: 'next' })
    .mockResolvedValueOnce({ entry, text: 'tail', complete: true })
  await render()
  await click('Topic')
  await click('Edit memory')
  expect(host.querySelector('textarea')?.value).toBe('headtail')
  await click('Save memory')
  expect(api.updateAgentMemoryEntry).toHaveBeenCalledWith(
    'agent',
    { ref: 'opaque-ref', revision: 'r1', text: 'headtail' },
    'one'
  )
})
it('keeps a draft and blocks replay after an ambiguous response', async () => {
  vi.mocked(api.updateAgentMemoryEntry).mockRejectedValueOnce(new api.ApiError('lost', 503, 'AMBIGUOUS_WRITE'))
  await render()
  await click('Topic')
  await click('Edit memory')
  await click('Save memory')
  expect(host.querySelector('textarea')?.value).toBe('headtail')
  expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Save memory')?.disabled).toBe(true)
  await click('Save memory')
  expect(api.updateAgentMemoryEntry).toHaveBeenCalledTimes(1)
  await click('Reload saved version')
  expect(host.querySelector('textarea')).toBeNull()
})
it('never offers editing partial or inherited memory, or writes to a viewer', async () => {
  vi.mocked(api.getAgentMemoryEntry).mockResolvedValueOnce({ entry, text: 'head', complete: false })
  await render()
  await click('Topic')
  expect(host.textContent).not.toContain('Edit memory')
  vi.mocked(api.getAgentMemoryEntry).mockResolvedValue({
    entry: { ...entry, origin: 'inherited', editable: false },
    text: 'base',
    complete: true
  })
  await click('Topic')
  expect(host.textContent).not.toContain('Edit memory')
  await render('two', false)
  expect(host.textContent).not.toContain('New memory')
})
it('drops late content when switching channel scope', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.getAgentMemoryEntry>>) => void
  vi.mocked(api.getAgentMemoryEntry).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  await render()
  await click('Topic')
  await render('two')
  await act(async () => resolve({ entry, text: 'old private content', complete: true }))
  expect(host.textContent).not.toContain('old private content')
})
it('falls back for an old peer and pages lists explicitly', async () => {
  vi.mocked(api.listAgentMemoryEntries).mockResolvedValueOnce({
    entries: [entry],
    consistency: 'snapshot',
    order: 'topic',
    nextCursor: 'next'
  })
  await render()
  await click('Load more')
  expect(api.listAgentMemoryEntries).toHaveBeenLastCalledWith('agent', 'one', 'next')
  // An older daemon has no entry view; the card says so instead of browsing, and Refresh stays for after the upgrade.
  vi.mocked(api.describeAgentMemoryEntries).mockRejectedValueOnce(new api.ApiError('old', 501, 'UNSUPPORTED'))
  await render('two')
  expect(host.textContent).toContain('does not serve the memory entry interface')
  expect(host.textContent).not.toContain('Select a memory')
  vi.mocked(api.describeAgentMemoryEntries).mockResolvedValue({ ...caps, operations: ['search'] })
  await click('Refresh')
  expect(host.textContent).toContain('does not serve the memory entry interface')
})
it('requires deletion confirmation and submits the selected revision', async () => {
  vi.mocked(api.deleteAgentMemoryEntry).mockResolvedValue({ operationId: 'op', state: 'completed' })
  await render()
  await click('Topic')
  await click('Delete memory')
  expect(api.deleteAgentMemoryEntry).not.toHaveBeenCalled()
  await click('Confirm deletion')
  expect(api.deleteAgentMemoryEntry).toHaveBeenCalledWith('agent', { ref: 'opaque-ref', revision: 'r1' }, 'one')
})
it('prevents a mutation exceeding the advertised request budget', async () => {
  vi.mocked(api.describeAgentMemoryEntries).mockResolvedValue({
    ...caps,
    limits: { ...caps.limits, maxMutationRequestBytes: 10 }
  })
  await render()
  await click('New memory')
  expect(host.textContent).toContain('too large')
  await click('Save memory')
  expect(api.createAgentMemoryEntry).not.toHaveBeenCalled()
})

it('recovers an unconfirmed first create only after an explicit complete empty refresh', async () => {
  vi.mocked(api.listAgentMemoryEntries).mockResolvedValue({ entries: [], consistency: 'live', order: 'topic' })
  vi.mocked(api.createAgentMemoryEntry).mockRejectedValueOnce(new api.ApiError('lost', 503, 'AMBIGUOUS_WRITE'))
  await render()
  await click('New memory')
  await click('Save memory')
  const save = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save memory')!
  expect(save().disabled).toBe(true)
  vi.mocked(api.listAgentMemoryEntries).mockResolvedValueOnce({
    entries: [],
    consistency: 'live',
    order: 'topic',
    nextCursor: 'more'
  })
  await click('Refresh')
  expect(save().disabled).toBe(true)
  vi.mocked(api.listAgentMemoryEntries).mockRejectedValueOnce(new Error('offline'))
  await click('Refresh')
  expect(save().disabled).toBe(true)
  await click('Refresh')
  expect(save().disabled).toBe(false)
  expect(api.createAgentMemoryEntry).toHaveBeenCalledTimes(1)
})
it('searches only when advertised, shows what a hit can prove, and opens a hit like an entry', async () => {
  await render()
  expect(host.querySelector('input[aria-label="Search memory"]')).toBeNull()
  vi.mocked(api.describeAgentMemoryEntries).mockResolvedValue({
    ...caps,
    operations: [...caps.operations, 'search'],
    searchKind: 'lexical'
  })
  vi.mocked(api.searchAgentMemoryEntries).mockResolvedValue({
    kind: 'lexical',
    coverage: 'partial',
    hits: [{ entry: { ...entry, ref: 'hit-ref', label: 'Deploy' }, snippet: '…Deploy on Fridays…' }]
  })
  await render('two')
  const input = host.querySelector('input[aria-label="Search memory"]') as HTMLInputElement
  expect(input).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'fridays')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Search')
  expect(api.searchAgentMemoryEntries).toHaveBeenCalledWith('agent', 'fridays', 'two')
  expect(host.textContent).toContain('…Deploy on Fridays…')
  expect(host.textContent).toContain('lexical search · partial coverage')
  expect(host.textContent).not.toContain('Topic')
  await click('Deploy')
  expect(api.getAgentMemoryEntry).toHaveBeenCalledWith('agent', 'hit-ref', 'two', undefined)
  await click('Clear search')
  expect(host.textContent).toContain('Topic')
  expect(host.textContent).not.toContain('Deploy on Fridays')
})
it('renders Markdown entries with annotated links, follows only annotated targets, and keeps text entries raw', async () => {
  vi.mocked(api.getAgentMemoryEntry).mockResolvedValue({
    entry,
    text: '# Deploy',
    complete: true,
    links: [
      { label: 'oncall', ref: 'oncall-ref', exists: true },
      { label: 'missing', exists: false }
    ],
    backlinks: [{ label: 'rota', ref: 'rota-ref', exists: true }]
  })
  await render()
  await click('Topic')
  expect(host.querySelector('[data-testid="markdown"]')?.textContent).toContain('# Deploy')
  expect(host.querySelector('pre')).toBeNull()
  expect(host.textContent).toContain('Links: oncall, missing (missing)')
  expect(host.textContent).toContain('Backlinks: rota')
  expect(host.querySelector('[data-testid="stray"]')?.textContent).toBe('blocked')
  await click('rota')
  expect(api.getAgentMemoryEntry).toHaveBeenLastCalledWith('agent', 'rota-ref', 'one', undefined)
  await click('follow oncall.md')
  expect(api.getAgentMemoryEntry).toHaveBeenLastCalledWith('agent', 'oncall-ref', 'one', undefined)
  vi.mocked(api.getAgentMemoryEntry).mockResolvedValue({
    entry: { ...entry, format: 'text' },
    text: 'plain record',
    complete: true
  })
  await click('Topic')
  expect(host.querySelector('pre')?.textContent).toBe('plain record')
  expect(host.querySelector('[data-testid="markdown"]')).toBeNull()
})

it('offers history only when advertised and pages the entry change log by ref', async () => {
  await render()
  await click('Topic')
  expect(host.textContent).not.toContain('History')
  vi.mocked(api.describeAgentMemoryEntries).mockResolvedValue({ ...caps, operations: [...caps.operations, 'history'] })
  vi.mocked(api.listAgentMemoryEntryHistory)
    .mockResolvedValueOnce({
      order: 'newest-first',
      nextCursor: 'older',
      events: [{ id: 'e2', kind: 'update', at: '2026-09-14T12:00:00.000Z', source: 'console', before: 'a', after: 'b' }]
    })
    .mockResolvedValueOnce({
      order: 'newest-first',
      events: [{ id: 'e1', kind: 'create', at: '2026-09-13T12:00:00.000Z', source: 'tool', after: 'a' }]
    })
  await render('two')
  await click('Topic')
  await click('History')
  expect(api.listAgentMemoryEntryHistory).toHaveBeenCalledWith('agent', 'opaque-ref', 'two', undefined)
  expect(host.textContent).toContain('Updated')
  expect(host.textContent).toContain('Console')
  await click('Load older changes')
  expect(api.listAgentMemoryEntryHistory).toHaveBeenLastCalledWith('agent', 'opaque-ref', 'two', 'older')
  expect(host.textContent).toContain('Created')
  expect(host.textContent).toContain('Agent tool')
  expect(host.textContent).not.toContain('Load older changes')
  await click('Hide history')
  expect(host.textContent).not.toContain('Updated')
})

it('recovers paging after a refresh outdates a pending page request', async () => {
  await render()
  let resolvePage!: (value: Awaited<ReturnType<typeof api.listAgentMemoryEntries>>) => void
  vi.mocked(api.listAgentMemoryEntries)
    .mockResolvedValueOnce({ entries: [entry], consistency: 'live', order: 'topic', nextCursor: 'next' })
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePage = r
        })
    )
  await click('Refresh')
  await click('Load more')
  expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Loading…')).toBeTruthy()
  vi.mocked(api.listAgentMemoryEntries).mockResolvedValueOnce({
    entries: [entry],
    consistency: 'live',
    order: 'topic',
    nextCursor: 'again'
  })
  await click('Refresh')
  await act(async () => resolvePage({ entries: [], consistency: 'live', order: 'topic' }))
  const more = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Load more')
  expect(more?.disabled).toBe(false)
})

it('wakes a sleeping sandbox instead of reporting a generic failure', async () => {
  vi.mocked(api.describeAgentMemoryEntries)
    .mockRejectedValueOnce(new api.ApiError('asleep', 503, 'WORKSPACE_SANDBOX_UNAVAILABLE'))
    .mockResolvedValue(caps)
  await render()
  // The refusal presses the wake once and the tree shows the sandbox starting, never the generic failure or the old view.
  expect(api.wakeAgent).toHaveBeenCalledWith('agent')
  expect(host.textContent).toContain('Starting')
  expect(host.textContent).not.toContain('temporarily unavailable')
})

it('pins the overview when given, labels a hand-written one, and follows its links by filename, read-only', async () => {
  type File = { exists: boolean; content: string; mtime: string | null }
  const overview: File = {
    exists: true,
    content: "# Memory\n\n<!-- generated from each topic's `description` header -->\n\n- [Later](oncall.md)",
    mtime: '2026-09-14T00:00:00.000Z'
  }
  // A fresh object per read, as a fetch would give; the same reference would let React skip the re-render.
  const read = vi.fn(async () => ({ ...overview }))
  let resolveTopic!: (value: File) => void
  const readTopic = vi.fn(
    () =>
      new Promise<File>((r) => {
        resolveTopic = r
      })
  )
  await act(async () => root.render(<UnifiedMemoryPanel agentId="agent" canEdit overview={{ read, readTopic }} />))
  expect(host.textContent).toContain('MEMORY.md')
  await click('MEMORY.md')
  expect(read).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('generated from topic descriptions')
  expect(host.textContent).not.toContain('Edit memory')
  // Any flat memory filename is a destination; a missing one says so after the read, below.
  expect(host.querySelector('[data-testid="stray"]')?.textContent).toBe('action')
  // The href names the file; while it loads, nothing that could take a draft is offered.
  await click('follow oncall.md')
  expect(readTopic).toHaveBeenCalledWith('oncall.md')
  expect([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('New memory'))?.disabled).toBe(true)
  await act(async () => resolveTopic({ exists: true, content: 'On call rota', mtime: null }))
  expect(host.textContent).toContain('On call rota')
  expect(host.textContent).toContain('oncall.md')
  expect(host.textContent).toContain('read-only')
  expect(host.textContent).not.toContain('Edit memory')
  expect(api.getAgentMemoryEntry).not.toHaveBeenCalled()
  await click('Back to overview')
  expect(host.textContent).toContain('generated from topic descriptions')
  // A read still in flight when a new memory starts is dropped, so it can never replace the draft.
  await click('follow oncall.md')
  await click('MEMORY.md')
  await act(async () => resolveTopic({ exists: true, content: 'stale topic', mtime: null }))
  expect(host.textContent).not.toContain('stale topic')
  overview.content = '# Mine\n\n[read this](oncall.md)'
  overview.mtime = null
  await click('MEMORY.md')
  expect(host.textContent).toContain('hand-written')
  await click('follow oncall.md')
  await act(async () => resolveTopic({ exists: false, content: '', mtime: null }))
  expect(host.textContent).toContain('This topic no longer exists.')
})

it('shows a record’s metadata under its text', async () => {
  vi.mocked(api.getAgentMemoryEntry).mockResolvedValue({
    entry: { ...entry, format: 'text' },
    text: 'plain record',
    complete: true,
    metadata: { source: 'slack', tags: ['ops', 'rpc'] }
  })
  await render()
  await click('Topic')
  expect(host.textContent).toContain('source')
  expect(host.textContent).toContain('slack')
  expect(host.textContent).toContain('["ops","rpc"]')
})

it('drops stale capabilities when the list refuses the interface after a describe answered', async () => {
  vi.mocked(api.describeAgentMemoryEntries).mockResolvedValue({ ...caps, operations: [...caps.operations, 'search'] })
  vi.mocked(api.listAgentMemoryEntries).mockRejectedValueOnce(new api.ApiError('old', 501, 'UNSUPPORTED'))
  await render()
  expect(host.textContent).toContain('does not serve the memory entry interface')
  expect(host.textContent).not.toContain('New memory')
  expect(host.querySelector('input[aria-label="Search memory"]')).toBeNull()
  expect([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh'))?.disabled).toBe(false)
  await click('Refresh')
  expect(host.textContent).not.toContain('does not serve the memory entry interface')
  expect(host.textContent).toContain('New memory')
})
