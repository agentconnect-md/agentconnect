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
  fetchAgentMemoryFull: vi.fn()
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

async function render(props: { canEdit?: boolean; dreamingEnabled?: boolean } = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <DreamPanel agentId={AGENT} canEdit={props.canEdit ?? true} dreamingEnabled={props.dreamingEnabled ?? true} />
    )
  })
  return container
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)

describe('DreamPanel', () => {
  it('triggers a dream and tells the user it costs a model run', async () => {
    const host = await render()
    // The cost/latency is stated up front — this is not a free click.
    expect(host.textContent).toContain('costs tokens')

    await act(async () => button(host, 'Dream now')?.click())
    expect(api.startDream).toHaveBeenCalledWith(AGENT)
  })

  it('blocks the trigger for a viewer and when dreaming is off, with the reason', async () => {
    const viewer = await render({ canEdit: false })
    expect(button(viewer, 'Dream now')?.disabled).toBe(true)
    expect(viewer.textContent).toContain('edit access')
    await act(async () => root?.unmount())
    container?.remove()

    const off = await render({ dreamingEnabled: false })
    expect(button(off, 'Dream now')?.disabled).toBe(true)
    expect(off.textContent).toContain('Turn on dreaming')
    expect(api.startDream).not.toHaveBeenCalled()
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
  })

  it('discards a staged dream without touching live memory', async () => {
    api.listDreams.mockResolvedValue([dream()])
    const host = await render()
    await act(async () => button(host, 'Review')?.click())
    await act(async () => button(host, 'Discard')?.click())
    expect(api.discardDream).toHaveBeenCalledWith(AGENT, 'drm-1')
    expect(api.adoptDream).not.toHaveBeenCalled()
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
    expect(host.textContent).toContain('already running')
  })
})
