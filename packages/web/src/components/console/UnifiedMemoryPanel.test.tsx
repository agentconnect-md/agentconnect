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
    createAgentMemoryEntry: vi.fn(),
    updateAgentMemoryEntry: vi.fn(),
    deleteAgentMemoryEntry: vi.fn()
  }
})
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
  await act(async () =>
    root.render(
      <UnifiedMemoryPanel agentId="agent" channelKey={channelKey} canEdit={canEdit}>
        <div>Legacy memory tools</div>
      </UnifiedMemoryPanel>
    )
  )
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
  vi.mocked(api.describeAgentMemoryEntries).mockRejectedValueOnce(new api.ApiError('old', 501, 'UNSUPPORTED'))
  await render('two')
  expect(host.textContent).toContain('Legacy memory tools')
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
