// @vitest-environment happy-dom

// The cold load in no-auth mode, where the console really is server-rendered: the browser paints SSR markup before hydration and the server has no localStorage, so the track's width can only come from the pre-paint script and hydration must not take it back — none of which `createRoot` can observe, so every case here goes through `hydrateRoot` over markup a server render produced.

import { act } from 'react'
import { hydrateRoot, createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const orgs = vi.hoisted(() => ({ activeOrg: { id: 'org-1' } as { id: string } | null }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ orgPath: (path: string) => path, activeOrg: orgs.activeOrg })
}))

// `default` too, because the `(app)` layout renders the shell around its scripts and this suite mounts that layout to prove the script is wired into it.
vi.mock('@/components/console/Shell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-shell="">{children}</div>,
  useMobileActionSlot: () => ({ action: null, register: () => {} })
}))

import AppLayout from '@/app/(app)/layout'
import { DOCK_LABEL_WIDTH, SessionDock, SessionDockSlot, type DockTab } from './SessionDock'
import { DOCK_WIDTH_DEFAULT, DOCK_WIDTH_INIT, DOCK_WIDTH_PROPERTY, fitDockWidth, writeDockWidth } from './dock-width'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const TABS: DockTab[] = [{ key: 'sessions', label: 'Sessions', icon: 'messages-square' }]
const dock = () => (
  <SessionDock tabs={TABS} activeKey="sessions" onTabChange={() => {}}>
    <div data-body="">panel body</div>
  </SessionDock>
)

/** The width every dock node is sized from, and the only place a width can be before React exists. */
const applied = () => document.documentElement.style.getPropertyValue(DOCK_WIDTH_PROPERTY)
/** The inline script the `(app)` layout puts in front of the console markup; happy-dom does not run script tags, so the source is evaluated directly. */
const paintScript = () => new Function(DOCK_WIDTH_INIT)()
const track = () => container.querySelector<HTMLElement>('[data-dock-track]')!

let container: HTMLDivElement
let root: Root | null = null
let recovered: unknown[]
let errors: string[]

beforeEach(() => {
  orgs.activeOrg = { id: 'org-1' }
  window.innerWidth = 1920
  window.localStorage.clear()
  document.documentElement.style.removeProperty(DOCK_WIDTH_PROPERTY)
  container = document.createElement('div')
  document.body.appendChild(container)
  recovered = []
  errors = []
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container.remove()
  vi.restoreAllMocks()
})

/** The markup a Node server produces: rendered with `window` hidden, so there is no localStorage to read and no viewport to fit — the real SSR inputs. */
function serverMarkup(node: React.ReactNode) {
  vi.stubGlobal('window', undefined)
  try {
    return renderToString(node)
  } finally {
    vi.unstubAllGlobals()
  }
}

/** Put that markup in the document, as the response body would. */
function serve(node: React.ReactNode) {
  container.innerHTML = serverMarkup(node)
}

/** Hydrate over it, recording anything React had to recover from — a mismatch is one of those. */
function hydrate(node: React.ReactNode) {
  // `useLayoutEffect` warns under a server render in this environment (in Next it is `useEffect`, since `window` is undefined) — only hydration errors are collected.
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
  act(() => {
    root = hydrateRoot(container, node, { onRecoverableError: (error) => recovered.push(error) })
  })
  spy.mockRestore()
}

const hydrationErrors = () => errors.filter((message) => /hydrat|did not match|server/i.test(message))

describe('SessionDockSlot on a server-rendered first paint', () => {
  it('puts no width in the markup at all, so what the server did not know cannot be wrong in it', () => {
    writeDockWidth('org-1', 612)
    const dragged = serverMarkup(<SessionDockSlot />)
    window.localStorage.clear()
    const untouched = serverMarkup(<SessionDockSlot />)

    expect(dragged).toBe(untouched)
    expect(dragged).not.toContain('style')
    expect(dragged).toContain('w-[var(--dock-width)]')
  })

  it('paints the stored width before React runs at all', () => {
    // The first painted frame: server markup in the document, the head script run, and no React on the page yet.
    writeDockWidth('org-1', 612)
    serve(<SessionDockSlot />)
    paintScript()

    expect(applied()).toBe('612px')
    expect(track().className).toContain('w-[var(--dock-width)]')
    expect(track().getAttribute('style')).toBeNull()
  })

  it('still carries it once React hydrates over that markup', () => {
    writeDockWidth('org-1', 612)
    serve(<SessionDockSlot />)
    paintScript()
    hydrate(<SessionDockSlot />)

    expect(applied()).toBe('612px')
    expect(track().getAttribute('style')).toBeNull()
    expect(recovered).toEqual([])
    expect(hydrationErrors()).toEqual([])
  })

  it('bends it to the viewport in the same frame, since the script is the only party that knows one', () => {
    writeDockWidth('org-1', 700)
    window.innerWidth = 1366
    serve(<SessionDockSlot />)
    paintScript()
    expect(applied()).toBe(`${fitDockWidth(700, 1366)}px`)

    hydrate(<SessionDockSlot />)
    expect(applied()).toBe(`${fitDockWidth(700, 1366)}px`)
  })

  it('renders the default with no stored width, and with no storage to read', () => {
    // Restored here rather than in `afterEach`: a storage that still throws would silently turn every later case into this one.
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('private mode')
    })
    serve(<SessionDockSlot />)
    expect(() => paintScript()).not.toThrow()
    hydrate(<SessionDockSlot />)

    expect(applied()).toBe(`${DOCK_WIDTH_DEFAULT}px`)
    expect(recovered).toEqual([])
    getItem.mockRestore()
  })
})

describe('SessionDock on a server-rendered first paint', () => {
  it('hydrates onto the painted width and settles its own numbers on it', () => {
    writeDockWidth('org-1', 612)
    serve(dock())
    paintScript()
    expect(applied()).toBe('612px')

    hydrate(dock())

    expect(applied()).toBe('612px')
    expect(track().getAttribute('style')).toBeNull()
    expect(container.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')).toBe('612')
    expect(recovered).toEqual([])
    expect(hydrationErrors()).toEqual([])
  })

  it('settles the width-derived label rule at hydration, which no markup could carry', () => {
    // Honest limit of the mechanism: only the WIDTH is on the first painted frame, so the SSR frame collapses the inactive labels and the hydrated frame restores them — before it paints and with no mismatch, but the SSR frame did show them collapsed.
    writeDockWidth('org-1', DOCK_LABEL_WIDTH + 40)
    const twoTabs = (
      <SessionDock
        tabs={[...TABS, { key: 'files', label: 'Files', icon: 'folder-tree' }]}
        activeKey="sessions"
        onTabChange={() => {}}
      >
        <div data-body="">panel body</div>
      </SessionDock>
    )
    container.innerHTML = serverMarkup(twoTabs)
    expect(container.querySelectorAll('[data-dock-label]')).toHaveLength(1)

    paintScript()
    hydrate(twoTabs)

    expect(applied()).toBe(`${DOCK_LABEL_WIDTH + 40}px`)
    expect(container.querySelectorAll('[data-dock-label]')).toHaveLength(2)
    expect(recovered).toEqual([])
  })

  it('keeps the width when the organization has not resolved either', () => {
    // Both unknowns at once, which is the shipped default: SSR with no storage, then a client whose org list is still in flight.
    writeDockWidth('org-1', 612)
    orgs.activeOrg = null
    serve(dock())
    paintScript()
    hydrate(dock())

    expect(applied()).toBe('612px')
    expect(container.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')).toBe('612')
  })
})

// Everything above starts from `paintScript()`, which is a suite calling the source directly — this is the one place that mechanism is WIRED, and deleting the line left every suite green while first paint reverted to the stylesheet default.
describe('the pre-paint script in the console layout', () => {
  const scriptsIn = (markup: string) => Array.from(markup.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g), (m) => m[1]!)

  it('is shipped in front of the console markup by the `(app)` layout', () => {
    const markup = renderToString(<AppLayout>{<div data-page="" />}</AppLayout>)
    expect(scriptsIn(markup)).toContain(DOCK_WIDTH_INIT)
    // Ahead of the shell, since a script after the markup it sizes is a script that runs after the frame it was meant to paint.
    expect(markup.indexOf(DOCK_WIDTH_INIT)).toBeLessThan(markup.indexOf('data-shell'))
  })

  it('paints the stored width when run as the browser runs it, from that markup', () => {
    // Not mere presence: the text the layout actually ships is evaluated here, so a truncated or mis-escaped script fails too.
    writeDockWidth('org-1', 612)
    const shipped = scriptsIn(renderToString(<AppLayout>{<div data-page="" />}</AppLayout>)).find((source) =>
      source.includes(DOCK_WIDTH_PROPERTY)
    )
    expect(shipped).toBeDefined()
    new Function(shipped!)()
    expect(applied()).toBe('612px')
  })
})

// Why the width is a property and not an inline style — and the proof this harness can see the difference, which a `createRoot` test cannot.
describe('an inline width React owns in server markup', () => {
  const Probe = ({ width }: { width: number }) => <div data-probe="" style={{ width }} suppressHydrationWarning />
  const probe = () => container.querySelector<HTMLElement>('[data-probe]')!

  it("stays at the server's number through hydration, which is the defect the property avoids", () => {
    container.innerHTML = renderToString(<Probe width={DOCK_WIDTH_DEFAULT} />)
    hydrate(<Probe width={612} />)
    expect(probe().style.width).toBe(`${DOCK_WIDTH_DEFAULT}px`)
  })

  it("takes the client's number under createRoot, which is why a createRoot suite stays green over it", () => {
    const clientOnly = createRoot(container)
    act(() => clientOnly.render(<Probe width={612} />))
    expect(probe().style.width).toBe('612px')
    act(() => clientOnly.unmount())
  })
})

// `<html>` is React's own node (RootLayout renders it), so the carrier only works if React leaves a property a script put there alone. Last: it replaces the document.
describe('the property on a React-rendered <html>', () => {
  it('survives hydration of the whole document, which is where the script writes it', () => {
    document.documentElement.innerHTML = '<head><title>t</title></head><body><div id="host">x</div></body>'
    document.documentElement.style.setProperty(DOCK_WIDTH_PROPERTY, '612px')
    const document_ = (
      // The shape of `app/layout.tsx`, whose `<html>` already carries `suppressHydrationWarning` for the theme script's attribute.
      <html lang="en" suppressHydrationWarning>
        <head>
          <title>t</title>
        </head>
        <body>
          <div id="host">x</div>
        </body>
      </html>
    )
    act(() => {
      root = hydrateRoot(document, document_, { onRecoverableError: (error) => recovered.push(error) })
    })

    expect(applied()).toBe('612px')
    expect(recovered).toEqual([])
  })
})
