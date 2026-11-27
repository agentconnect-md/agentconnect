// @vitest-environment happy-dom

// The viewer opening by itself (artifacts.md §11.2, D23): which cards count as arrived, and when an arrival opens.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Turn } from '@/components/console/session-turns'
import type { FmtStep } from '@/components/console/transcript-steps'
import type { ArtifactViewerState } from '@/lib/artifact-viewer-url'
import { artifactArrivals, useArtifactAutoOpen } from './artifact-auto-open'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const A = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const B = '7c2e9f10-3a4b-4c5d-8e6f-1a2b3c4d5e6f'

const user = (key: string): Turn => ({ kind: 'user', key, text: key }) as unknown as Turn
const bot = (key: string, ...cards: [string, number][]): Turn =>
  ({
    kind: 'bot',
    key,
    steps: [
      { text: 'work' } as FmtStep,
      ...cards.map(
        ([artifactId, revision]) => ({ text: '', artifact: { artifactId, revision, title: 'T' } }) as FmtStep
      )
    ]
  }) as unknown as Turn
const ids = (markers: { artifactId: string; revision: number }[]) => markers.map((m) => `${m.artifactId}:${m.revision}`)

describe('artifactArrivals', () => {
  it('arrives nothing on the first pass, which is the history', () => {
    const { arrived } = artifactArrivals(null, [user('u1'), bot('b1', [A, 1])])
    expect(arrived).toEqual([])
  })

  it('arrives a card in a turn appended after the last pass', () => {
    const first = artifactArrivals(null, [user('u1'), bot('b1', [A, 1])])
    const { arrived } = artifactArrivals(first.next, [user('u1'), bot('b1', [A, 1]), user('u2'), bot('b2', [A, 2])])
    expect(ids(arrived)).toEqual([`${A}:2`])
  })

  it('arrives a card the last turn grew', () => {
    const first = artifactArrivals(null, [user('u1'), bot('b1')])
    const { arrived } = artifactArrivals(first.next, [user('u1'), bot('b1', [B, 1])])
    expect(ids(arrived)).toEqual([`${B}:1`])
  })

  it('arrives nothing from an earlier page prepended before the turns it knew', () => {
    const first = artifactArrivals(null, [user('u5'), bot('b5')])
    const { arrived } = artifactArrivals(first.next, [user('u1'), bot('b1', [A, 1]), user('u5'), bot('b5')])
    expect(arrived).toEqual([])
  })

  it('arrives a card once, even when its live turn is replaced by its saved row', () => {
    const first = artifactArrivals(null, [user('u1')])
    const live = artifactArrivals(first.next, [user('u1'), bot('b:live:t1', [A, 3])])
    expect(ids(live.arrived)).toEqual([`${A}:3`])
    const saved = artifactArrivals(live.next, [user('u1'), bot('b:s#4', [A, 3])])
    expect(saved.arrived).toEqual([])
  })

  it('arrives every card after an empty first page', () => {
    const first = artifactArrivals(null, [])
    const { arrived } = artifactArrivals(first.next, [user('u1'), bot('b1', [A, 1])])
    expect(ids(arrived)).toEqual([`${A}:1`])
  })

  it('arrives nothing when none of the turns it knew survive, as after a reset', () => {
    const first = artifactArrivals(null, [user('u1')])
    const { arrived } = artifactArrivals(first.next, [user('x1'), bot('x2', [A, 1])])
    expect(arrived).toEqual([])
  })
})

type Policy = ReturnType<typeof useArtifactAutoOpen>

describe('useArtifactAutoOpen', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let policy: Policy
  let hidden = false
  const open = vi.fn()

  function Harness(props: { viewer: ArtifactViewerState | null; fileOpen: boolean }) {
    policy = useArtifactAutoOpen({ scope: 'session-1', orgId: 'org-1', open, ...props })
    return <input data-composer="" />
  }
  async function render(viewer: ArtifactViewerState | null = null, fileOpen = false) {
    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <Harness viewer={viewer} fileOpen={fileOpen} />
        </SWRConfig>
      )
    })
  }
  const marker = (artifactId: string, revision: number) => ({ artifactId, revision, title: 'T' })

  beforeEach(() => {
    hidden = false
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible')
    })
    open.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('opens the newest arrival at its placement, pinned to its revision', async () => {
    await render()
    policy.arrived([marker(A, 1), marker(B, 2)], 'pane')
    expect(open).toHaveBeenCalledExactlyOnceWith({ artifactId: B, revision: 2 }, 'pane', undefined)
  })

  it('does not reopen a revision the person closed, but opens a newer one', async () => {
    await render()
    policy.closed({ artifactId: A, revision: 3, path: null, placement: 'dock' })
    policy.arrived([marker(A, 3)], 'dock')
    expect(open).not.toHaveBeenCalled()
    policy.arrived([marker(A, 4)], 'dock')
    expect(open).toHaveBeenCalledWith({ artifactId: A, revision: 4 }, 'dock', undefined)
  })

  it('counts a viewer closed on the latest as closed at the newest revision that arrived', async () => {
    await render()
    policy.arrived([marker(A, 2)], 'dock')
    policy.closed({ artifactId: A, path: null, placement: 'dock' })
    open.mockReset()
    policy.arrived([marker(A, 2)], 'dock')
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves an artifact the viewer already shows to the viewer’s own following', async () => {
    await render({ artifactId: A, revision: 2, path: null, placement: 'dock' })
    policy.arrived([marker(A, 3)], 'dock')
    expect(open).not.toHaveBeenCalled()
  })

  it('does not take the left pane from a workspace file, though the dock still opens', async () => {
    await render(null, true)
    policy.arrived([marker(A, 1)], 'pane')
    expect(open).not.toHaveBeenCalled()
    policy.arrived([marker(B, 1)], 'dock')
    expect(open).toHaveBeenCalledWith({ artifactId: B, revision: 1 }, 'dock', undefined)
  })

  it('keeps a hidden tab’s newest arrival and opens it when the person comes back', async () => {
    await render()
    hidden = true
    policy.arrived([marker(A, 1)], 'dock')
    policy.arrived([marker(A, 2)], 'dock')
    expect(open).not.toHaveBeenCalled()
    hidden = false
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(open).toHaveBeenCalledExactlyOnceWith({ artifactId: A, revision: 2 }, 'dock', undefined)
  })

  it('does not open a collapsed dock over a composer being typed in', async () => {
    await render()
    container.querySelector<HTMLInputElement>('[data-composer]')!.focus()
    policy.arrived([marker(A, 1)], 'dock')
    expect(open).toHaveBeenCalledWith({ artifactId: A, revision: 1 }, 'dock', { reveal: false })
  })
})
