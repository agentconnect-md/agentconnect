// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status: number) {
      super(`http ${status}`)
    }
  },
  startDream: vi.fn(),
  listDreams: vi.fn(),
  adoptDream: vi.fn(),
  discardDream: vi.fn(),
  cancelDream: vi.fn(),
  listDreamFiles: vi.fn(),
  fetchDreamFileFull: vi.fn(),
  fetchAgentMemoryFull: vi.fn(),
  listAgentMemory: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  ...api,
  isDreamTerminal: (s: string) => s !== 'pending' && s !== 'running'
}))

const FakeApiError = api.ApiError

import { DreamPanel } from './DreamPanel'

const AGENT = '33333333-3333-4333-8333-333333333333'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const dream = (over: Partial<Record<string, unknown>> = {}) => ({
  dreamId: 'drm-1',
  agentId: AGENT,
  status: 'completed',
  trigger: 'manual',
  sessionIds: ['s1', 's2'],
  snapshotDigest: 'sha256:x',
  instructions: null,
  skills: null,
  usage: null,
  error: null,
  createdAt: '2026-07-25T00:00:00.000Z',
  endedAt: '2026-07-25T00:05:00.000Z',
  ...over
})

beforeEach(() => {
  for (const [key, fn] of Object.entries(api)) if (key !== 'ApiError') (fn as ReturnType<typeof vi.fn>).mockReset()
  api.listDreams.mockResolvedValue([])
  api.startDream.mockResolvedValue(dream({ status: 'pending' }))
  api.listDreamFiles.mockResolvedValue({ exists: true, files: [{ name: 'MEMORY.md', size: 10, mtime: 'x' }] })
  api.fetchDreamFileFull.mockResolvedValue({ exists: true, content: '# Memory (rebuilt)' })
  api.fetchAgentMemoryFull.mockResolvedValue({ exists: true, content: '# Memory (old)', mtime: null })
  api.listAgentMemory.mockResolvedValue({ exists: true, files: [{ name: 'MEMORY.md', size: 10, mtime: 'x' }] })
  api.adoptDream.mockResolvedValue(dream({ status: 'adopted' }))
  api.discardDream.mockResolvedValue(dream({ status: 'discarded' }))
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

async function render(props: { canEdit?: boolean } = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<DreamPanel agentId={AGENT} canEdit={props.canEdit ?? true} />)
  })
  return container
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)

describe('DreamPanel', () => {
  it('triggers a dream and tells the user it costs a model run', async () => {
    const host = await render()
    await act(async () => button(host, 'Dream now')?.click())
    expect(document.body.textContent).toContain('uses model tokens')
    expect(api.startDream).not.toHaveBeenCalled()

    await act(async () => button(document.body, 'Start dream')?.click())
    expect(api.startDream).toHaveBeenCalledWith(AGENT)
  })

  it('keeps terminal history collapsed by default', async () => {
    api.listDreams.mockResolvedValue([dream({ status: 'adopted' }), dream({ dreamId: 'drm-2', status: 'superseded' })])
    const host = await render()
    const history = host.querySelector('details')
    expect(history?.open).toBe(false)
    expect(history?.querySelector('summary')?.textContent).toContain('History')
    expect(history?.querySelector('summary')?.textContent).toContain('2')
    expect(history?.textContent).toContain('Superseded')
  })

  it('uses the shared card shell with the action in its header', async () => {
    const host = await render()
    const card = host.querySelector('.card')
    const header = card?.querySelector(':scope > .cardhead')
    expect(card).not.toBeNull()
    expect(header?.querySelector('.cardtitle')?.textContent).toBe('Dreams')
    expect(button(header as HTMLElement, 'Dream now')).toBeTruthy()
  })

  it('blocks the trigger for a viewer, with the reason', async () => {
    // (Dreaming-off is no longer this component's concern — MemoryPanel does not
    // mount the panel at all in that case.)
    const viewer = await render({ canEdit: false })
    expect(button(viewer, 'Dream now')?.disabled).toBe(true)
    expect(viewer.textContent).toContain('edit access')
    expect(api.startDream).not.toHaveBeenCalled()
  })

  it('shows an upgrade note instead of a dead trigger when the daemon predates dreaming', async () => {
    api.listDreams.mockRejectedValue(Object.assign(new FakeApiError(409), { code: 'DAEMON_FEATURE_MISSING' }))
    const host = await render()
    expect(host.textContent).toContain('newer version')
    // No trigger at all — it could only ever 409.
    expect(button(host, 'Dream now')).toBeUndefined()
  })

  it('reflects an in-flight dream instead of letting the user hit a 409', async () => {
    api.listDreams.mockResolvedValue([dream({ status: 'running' })])
    const host = await render()
    const trigger = button(host, 'Dreaming…')
    expect(trigger).toBeTruthy()
    expect(trigger?.disabled).toBe(true)
    // …and offers the escape hatch.
    expect(button(host, 'Cancel')).toBeTruthy()
  })

  it('shows the live store beside the staged one when reviewing, then adopts', async () => {
    api.listDreams.mockResolvedValue([dream()])
    const host = await render()

    await act(async () => button(host, 'Review')?.click())
    await act(async () => {
      await Promise.resolve()
    })
    // Both sides are visible — the point of a staged dream.
    expect(host.textContent).toContain('# Memory (old)')
    expect(host.textContent).toContain('# Memory (rebuilt)')

    // Adopt is confirmed first (it replaces live memory) — nothing is called
    // until the user confirms in the dialog.
    await act(async () => button(host, 'Adopt')?.click())
    expect(document.body.textContent).toContain('replaces the agent’s live memory')
    expect(api.adoptDream).not.toHaveBeenCalled()

    // The dialog's confirm is the LAST 'Adopt' in the document (the review
    // panel's own button is still mounted behind it).
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Adopt'
    )
    await act(async () => confirm.at(-1)?.click())
    expect(api.adoptDream).toHaveBeenCalledWith(AGENT, 'drm-1')
    expect(host.textContent).toContain('Outdated proposals were moved to History')
  })

  it('discards a ready dream from its row without making the user open review', async () => {
    api.listDreams.mockResolvedValue([dream()])
    const host = await render()
    await act(async () => button(host, 'Discard')?.click())
    expect(api.discardDream).toHaveBeenCalledWith(AGENT, 'drm-1')
    expect(api.adoptDream).not.toHaveBeenCalled()
    expect(api.listDreamFiles).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Dream discarded')
  })

  it('reads an offline daemon as an expected state, not an error', async () => {
    api.listDreams.mockRejectedValue(new FakeApiError(503))
    const host = await render()
    expect(host.textContent).toContain('daemon is offline')
  })

  it('explains a 409 from a racing trigger in plain language', async () => {
    api.startDream.mockRejectedValue(new FakeApiError(409))
    const host = await render()
    await act(async () => button(host, 'Dream now')?.click())
    await act(async () => button(document.body, 'Start dream')?.click())
    expect(host.textContent).toContain('already running')
  })

  it('surfaces files the dream DELETES, which exist live but not in the staged tree', async () => {
    // A dream removes a topic simply by leaving it out. Listing only the staged
    // tree would hide the single most destructive change from the reviewer.
    api.listDreams.mockResolvedValue([dream()])
    api.listAgentMemory.mockResolvedValue({
      exists: true,
      files: [
        { name: 'MEMORY.md', size: 10, mtime: 'x' },
        { name: 'stale.md', size: 10, mtime: 'x' }
      ]
    })
    api.fetchDreamFileFull.mockImplementation(async (_a: string, _d: string, path: string) =>
      path === 'stale.md' ? { exists: false, content: '' } : { exists: true, content: '# Memory (rebuilt)' }
    )
    api.fetchAgentMemoryFull.mockImplementation(async (_a: string, path: string) =>
      path === 'stale.md'
        ? { exists: true, content: '- an obsolete note', mtime: null }
        : { exists: true, content: '# Memory (old)', mtime: null }
    )

    const host = await render()
    await act(async () => button(host, 'Review')?.click())
    await act(async () => {
      await Promise.resolve()
    })

    // Named up front, and the live-only file is selectable and marked.
    expect(host.textContent).toContain('Adopting removes 1 file')
    expect(host.textContent).toContain('stale.md')
    expect(host.textContent).toContain('Deleted by this dream')
    expect(host.textContent).toContain('- an obsolete note')
  })

  it('keeps revalidating once settled, so an externally started dream appears', async () => {
    // Scheduled dreams (and other consoles) start work we did not initiate; a
    // settled list that stopped polling would go stale until a page reload.
    vi.useFakeTimers()
    try {
      api.listDreams.mockResolvedValue([])
      const host = await render()
      expect(host.textContent).toContain('No dreams yet')

      api.listDreams.mockResolvedValue([dream({ status: 'running', trigger: 'schedule' })])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000)
      })
      expect(host.textContent).toContain('scheduled')
      expect(button(host, 'Dreaming…')?.disabled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the server message for an adoption fence conflict', async () => {
    // adopt's 409 is the snapshot fence, NOT the one-in-flight rule — telling
    // the user to "wait for the running dream" would be actively wrong.
    api.listDreams.mockResolvedValue([dream()])
    const fence = new FakeApiError(409)
    fence.message = 'the live store changed since this dream was snapshotted; rerun the dream or force'
    api.adoptDream.mockRejectedValue(fence)

    const host = await render()
    await act(async () => button(host, 'Review')?.click())
    await act(async () => button(host, 'Adopt')?.click())
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Adopt'
    )
    await act(async () => confirm.at(-1)?.click())

    expect(host.textContent).toContain('rerun the dream')
    expect(host.textContent).not.toContain('already running')
  })
})
