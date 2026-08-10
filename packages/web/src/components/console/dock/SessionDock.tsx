'use client'

// The session detail page's right dock — the SHELL only: tab strip, resize edge, and the box the caller's active panel draws into.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { useMobileActionSlot } from '@/components/console/Shell'
import {
  DOCK_WIDTH_DEFAULT,
  DOCK_WIDE_MIN,
  DOCK_WIDTH_MAX,
  DOCK_WIDTH_MIN,
  DOCK_WIDTH_PROPERTY,
  fitDockWidth,
  readDockWidth,
  writeDockWidth
} from './dock-width'

/** Above this RENDERED width every tab shows its label; at or below it only the active one does. Width-derived, not a setting. */
export const DOCK_LABEL_WIDTH = 560

/** How far one arrow-key press moves the dock's edge. */
export const DOCK_WIDTH_STEP = 16

/** What a tab draws. Both non-`ready` values reserve the same track and withhold the same chrome; they differ only in the placeholder the body shows while some OTHER tab is ready. */
export type DockTabStatus = 'ready' | 'loading' | 'empty'

/** One tab in the strip. The dock renders it; the caller owns what it means. */
export interface DockTab {
  /** Stable identity — what `onTabChange` and `onTabAction` report back. */
  key: string
  /** Shown beside the icon on the active tab, and on every tab above `DOCK_LABEL_WIDTH`. Part of the tab's accessible name. */
  label: string
  /** Lucide glyph for `<Icon>`; a name outside the set renders nothing at all. */
  icon: string
  /** Tooltip. Falls back to the label, and only while the label is not readable. */
  title?: string
  /** Count pill, in mono. Omit it rather than passing `0`, so an idle tab carries no empty badge. */
  badge?: string | number
  /** Glyph for this tab's header action, rendered only while the tab is active. */
  actionIcon?: string
  /** Accessible name for that action ("Refresh files"), required to render it. */
  actionLabel?: string
  /** Content state; absent = `ready`. The dock draws the body for a non-ready tab, and withholds its chrome — never the reserved track — when every tab is non-ready. */
  status?: DockTabStatus
}

const TAB_BASE =
  'relative flex flex-none items-center gap-[6px] border-0 bg-transparent px-3 py-[10px] font-sans text-[12.5px] font-medium leading-normal whitespace-nowrap transition-colors focus-visible:outline-none'
const TAB_ON = `${TAB_BASE} text-(--brand)`
const TAB_OFF = `${TAB_BASE} text-(--text-secondary) hover:text-(--text-primary)`

const BADGE_BASE = 'rounded-full px-[5px] py-px font-mono text-[10.5px] font-medium leading-normal'
const BADGE_ON = `${BADGE_BASE} bg-(--brand-soft) text-(--brand)`
const BADGE_OFF = `${BADGE_BASE} border border-(--border-subtle) bg-(--surface-active) text-(--text-secondary)`

const ACTION_BTN =
  'flex h-6 w-6 flex-none items-center justify-center rounded-sm border-0 bg-transparent text-(--text-secondary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none'

// `touch-none` so a touch drag moves the edge instead of scrolling the transcript.
const HANDLE_BASE =
  'absolute top-0 bottom-0 left-0 z-10 w-[5px] cursor-col-resize touch-none transition-colors focus-visible:outline-none'
const HANDLE_IDLE = `${HANDLE_BASE} bg-transparent hover:bg-(--brand-soft) focus-visible:bg-(--brand-soft)`
const HANDLE_DRAGGING = `${HANDLE_BASE} bg-(--brand)`

// What the dock draws for an active tab that has nothing of its own to draw.
const PLACEHOLDER =
  'flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary)'

// The reserved track, shared by the dock and `SessionDockSlot`: its −30px bleeds over `.content`'s padding so track + padding = the panel, it is `relative` so the vacant state's handle can sit on its left edge, and it holds the dock's width in EVERY status — a column given back when a verdict lands moves the transcript sideways, which is the invariant it exists for (§8).
const TRACK = 'relative -mr-[30px] hidden w-[var(--dock-width)] flex-none wide:block'
// Open below `wide:` the track carries only its out-of-flow child, so `contents` — a box would still be a flex item spending the row's gap.
const TRACK_OVERLAY = '-mr-[30px] contents w-[var(--dock-width)] flex-none wide:block'

// One panel node, three bands, FIXED in each: a sticky box in the padded `.content` scroller never sits flush, and the width is `DOCK_WIDTH_PROPERTY` so `max-desktop:w-auto` can override it for the sheet.
const PANEL =
  'fixed top-0 right-0 bottom-0 z-50 flex w-[var(--dock-width)] flex-col border-l border-(--border-subtle) bg-(--surface-app) shadow-(--shadow-lg) max-desktop:top-auto max-desktop:left-0 max-desktop:h-[80vh] max-desktop:w-auto max-desktop:rounded-t-lg max-desktop:border-t max-desktop:border-l-0 max-desktop:pb-[env(safe-area-inset-bottom,0px)] wide:z-auto wide:shadow-none'

const TRIGGER_BASE =
  'flex h-9 w-9 items-center justify-center rounded-full border bg-(--surface-card) shadow-(--shadow-sm) hover:text-(--text-primary) focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none'
const TRIGGER_ON = `${TRIGGER_BASE} border-(--brand) text-(--brand)`
const TRIGGER_OFF = `${TRIGGER_BASE} border-(--border-default) text-(--text-secondary)`

// Everything the width touches must land before the browser paints the hydrated frame; on the server React warns about `useLayoutEffect` and neither runs.
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** Viewport the applied width must fit, re-read on resize. Seeded 0 (= no constraint) on BOTH sides: a render-time `innerWidth` is a hydration mismatch. */
function useViewportWidth(): number {
  const [viewportWidth, setViewportWidth] = useState(0)
  useBeforePaint(() => {
    const sync = () => setViewportWidth(window.innerWidth)
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])
  return viewportWidth
}

// The pre-paint script (`DOCK_WIDTH_INIT`) owns the first frame, and `null` publishes nothing — how a caller that has not read storage or measured the viewport leaves that width standing.
function usePublishedWidth(width: number | null): void {
  useBeforePaint(() => {
    if (width !== null) document.documentElement.style.setProperty(DOCK_WIDTH_PROPERTY, `${width}px`)
  }, [width])
  // Deliberately not cleared on unmount: the last applied width is a better answer for the next mount than the stylesheet's default.
}

// Every tab stop inside the panel, in order. The `tabindex` ATTRIBUTE, not `tabIndex`: the strip's roving −1 tabs are not stops, and a default 0 is never written.
function focusStops(panel: HTMLElement): HTMLElement[] {
  const found = panel.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')
  return Array.from(found).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1')
}

// Tab off either end of the dialog wraps to the other, and focus that has escaped it entirely is brought back to the near end.
function trapFocus(panel: HTMLElement, event: globalThis.KeyboardEvent): void {
  const stops = focusStops(panel)
  const at = document.activeElement
  const back = event.shiftKey
  if (stops.length === 0) {
    event.preventDefault()
    panel.focus()
    return
  }
  const first = stops[0]!
  const last = stops[stops.length - 1]!
  // The panel BOX precedes every stop, so a backward Tab off it is the same edge as one off the first stop.
  if (!panel.contains(at) || (back ? at === first || at === panel : at === last)) {
    event.preventDefault()
    ;(back ? last : first).focus()
  }
}

/** The dock's footprint with nothing in it, held while the session loads — the persisted width, so the body never moves once the dock arrives. */
export function SessionDockSlot() {
  const { activeOrg } = useOrgs()
  const viewportWidth = useViewportWidth()
  // Storage is read for the property, never for the markup (the slot renders one tree on both sides), and withheld until the viewport is measured as the dock withholds until storage is read: at the seeded 0 the ceiling is `DOCK_WIDTH_MAX`, so an unfitted width would land over the script's fitted one.
  usePublishedWidth(viewportWidth === 0 ? null : fitDockWidth(readDockWidth(activeOrg?.id ?? ''), viewportWidth))
  return <div aria-hidden="true" data-dock-track="" className={TRACK} />
}

export function SessionDock({
  tabs,
  activeKey,
  onTabChange,
  onTabAction,
  onOverflow,
  overlayKey,
  label = 'Panels',
  children
}: {
  /** The strip, in order. The dock does not sort, filter or hide them. */
  tabs: DockTab[]
  /** Which tab's body `children` is currently drawing. */
  activeKey: string
  onTabChange: (key: string) => void
  /** The active tab's header action was pressed. */
  onTabAction?: (key: string) => void
  /** The shared overflow button was pressed — one menu for every tab. */
  onOverflow?: () => void
  /** What the dock is open beside; a change closes the overlay, so a tapped row does not leave the drawer over the session it opened. */
  overlayKey?: string
  /** Accessible name for the strip, the collapsed-band trigger and its overlay, and the app-bar action that replaces it on mobile. */
  label?: string
  /** The active panel. A function receives the live rendered width, for a body that lays out differently at 380px than at 760px. */
  children: ReactNode | ((width: number) => ReactNode)
}) {
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id ?? ''
  const uid = useId()

  // `null` until storage is read, which cannot happen in render: the server has none, and a first client render that disagreed with it would not hydrate.
  const [preferred, setPreferred] = useState<number | null>(null)
  const viewportWidth = useViewportWidth()
  // In the bottom sheet the panel's rendered width is the VIEWPORT's, which both the label rule and the resize handle have to know.
  const isMobile = useIsMobile()
  // The rendered width, and the only one anything below here sees: a 700px preference yields to the transcript on a 1366px laptop.
  const width = fitDockWidth(preferred ?? DOCK_WIDTH_DEFAULT, viewportWidth)
  const [dragging, setDragging] = useState(false)
  // Below `wide:` this latch is the ONLY visibility source: hover does not follow width, and a CSS reveal would fight `aria-expanded`.
  const [open, setOpen] = useState(false)
  // The drag reads the live width and viewport without re-binding its window listeners.
  const widthRef = useRef(width)
  const viewportRef = useRef(viewportWidth)
  // Detaches the in-flight drag, whether it ends on release or on unmount.
  const detachRef = useRef<(() => void) | null>(null)
  // A width dragged before `activeOrg` lands belongs to that org, not to the empty id: held here rather than written under `''`.
  const pendingWidth = useRef<number | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  // Whatever had focus when the overlay opened, so closing it hands focus back.
  const restoreRef = useRef<HTMLElement | null>(null)

  const active = tabs.find((tab) => tab.key === activeKey)
  const activeStatus = active?.status ?? 'ready'
  // Nothing in any tab is nothing to open: withhold every control that opens a void, and draw no panel. The TRACK is still reserved — only the resize handle stays reachable in it.
  const vacant = tabs.every((tab) => (tab.status ?? 'ready') !== 'ready')
  // Where the panel IS an overlay, and therefore a modal dialog: the same viewport read `dockWidthCeiling` gates the inline ceiling on, so both agree on the band.
  const overlayBand = viewportWidth > 0 && viewportWidth < DOCK_WIDE_MIN

  useBeforePaint(() => {
    widthRef.current = width
    viewportRef.current = viewportWidth
  }, [width, viewportWidth])

  // Held back until the dock has a width of its own, so the property never hears the default over the one already on screen.
  usePublishedWidth(preferred === null ? null : width)

  // Fitted before it is stored, so the edge stops at the transcript's floor rather than persisting a width the reader never saw.
  const applyWidth = useCallback((next: number) => {
    const fitted = fitDockWidth(next, viewportRef.current)
    widthRef.current = fitted
    setPreferred(fitted)
    return fitted
  }, [])

  // Under `''` the entry would take one of the 20 remembered slots and answer every later pre-org first paint, for an org it was never the width of.
  const persistWidth = useCallback(
    (next: number) => {
      if (orgId) writeDockWidth(orgId, next)
      else pendingWidth.current = next
    },
    [orgId]
  )
  // The drag's `end` runs on a raw window listener captured at pointerdown, so it must not close over an `orgId` that has since landed — that wrote the release to `''`.
  const persistRef = useRef(persistWidth)
  useBeforePaint(() => {
    persistRef.current = persistWidth
  }, [persistWidth])

  // Mount reads storage here rather than in render (hydration), and `activeOrg` can resolve later still — the width is org-scoped.
  const seededOrg = useRef<string | null>(null)
  useBeforePaint(() => {
    if (seededOrg.current === orgId) return
    seededOrg.current = orgId
    const pending = pendingWidth.current
    pendingWidth.current = null
    // The reader's own answer for the org that just landed: a drag still under their finger, or one that ended before it did. Either outranks a stored preference.
    const own = dragging ? widthRef.current : pending
    if (own !== null && orgId) writeDockWidth(orgId, applyWidth(own))
    // The stored PREFERENCE, unfitted: a width bent to a laptop must come back whole on a monitor.
    else setPreferred(readDockWidth(orgId))
  }, [dragging, orgId, applyWidth])

  useEffect(() => () => detachRef.current?.(), [])

  // Dragging the edge across the transcript would otherwise select every line the pointer passed over.
  useEffect(() => {
    if (!dragging) return
    const previous = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.userSelect = previous
    }
  }, [dragging])

  const toggleOverlay = useCallback(() => setOpen((v) => !v), [])
  const closeOverlay = useCallback(() => setOpen(false), [])
  // ≤768px has no room to float a trigger over the session title, so the button lives in the shell's app bar and the panel stays here.
  const { register: registerMobileAction } = useMobileActionSlot()
  useEffect(() => {
    if (vacant) return
    registerMobileAction({ icon: 'panel-right', label, active: open, onClick: toggleOverlay })
    return () => registerMobileAction(null)
  }, [vacant, label, open, toggleOverlay, registerMobileAction])
  useEffect(() => setOpen(false), [overlayKey])
  // A latch left standing when the panel loses its content would re-open over the next session that arrives.
  useEffect(() => {
    if (vacant) setOpen(false)
  }, [vacant])
  // Above `wide:` the panel is the column: nothing hides it, its close button and scrim are `wide:hidden`, so a latch carried across the boundary is unclosable state.
  useEffect(() => {
    if (!overlayBand) setOpen(false)
  }, [overlayBand])

  // In the collapsed bands the overlay is a MODAL dialog: it takes focus, keeps it, gives it back, and answers Escape — as its own agent picker does.
  useEffect(() => {
    if (!open || !overlayBand) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus()
    // A popover INSIDE the panel marks Escape handled, so one press closes the menu rather than the drawer around it.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setOpen(false)
      // A scrim already blocks the page behind, so Tab must not walk into what a pointer cannot reach.
      if (event.key === 'Tab' && panelRef.current) trapFocus(panelRef.current, event)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      // The live viewport rather than anything React holds, so this cannot turn on effect ordering: a teardown by a resize INTO the inline band is no dismissal — the panel is still on screen, so focus stays where the reader left it.
      if (window.innerWidth >= DOCK_WIDE_MIN) return
      // `<body>` is where the scrim leaves it — clicking a non-focusable element focuses nothing — so that counts as focus the dialog still owes back.
      const at = document.activeElement
      if (!at || at === document.body || panelRef.current?.contains(at)) restoreRef.current?.focus()
    }
  }, [open, overlayBand])

  // The handle is on the dock's LEFT edge, so the pointer moving right shrinks it.
  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button > 0) return
      event.preventDefault()
      const pointerId = event.pointerId
      const startX = event.clientX
      const startWidth = widthRef.current
      // Capture keeps the drag with the handle once the pointer leaves it, which is also what makes it work under a finger.
      try {
        event.currentTarget.setPointerCapture(pointerId)
      } catch {
        /* a pointer that already ended has nothing to capture — the window listeners carry the drag anyway */
      }
      const move = (moved: globalThis.PointerEvent) => {
        if (moved.pointerId === pointerId) applyWidth(startWidth + (startX - moved.clientX))
      }
      const detach = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        detachRef.current = null
      }
      // Persist once, on release — a write per move event would be hundreds of them — and through the ref, since the org may have landed since pointerdown.
      function end(ended: globalThis.PointerEvent) {
        if (ended.pointerId !== pointerId) return
        detach()
        setDragging(false)
        persistRef.current(widthRef.current)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
      detachRef.current = detach
      setDragging(true)
    },
    [applyWidth]
  )

  const onHandleKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.key === 'ArrowLeft' ? DOCK_WIDTH_STEP : event.key === 'ArrowRight' ? -DOCK_WIDTH_STEP : 0
      if (!step) return
      event.preventDefault()
      // No release to persist on, so each press is its own settled width.
      persistWidth(applyWidth(widthRef.current + step))
    },
    [applyWidth, persistWidth]
  )

  // One tab stop for the strip, arrows between the tabs inside it — the ARIA tabs pattern, selection following focus.
  const onStripKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (!step || tabs.length < 2) return
      event.preventDefault()
      const from = tabs.findIndex((tab) => tab.key === activeKey)
      const next = tabs[(Math.max(from, 0) + step + tabs.length) % tabs.length]!
      onTabChange(next.key)
      stripRef.current?.querySelector<HTMLElement>(`[data-dock-tab="${next.key}"]`)?.focus()
    },
    [activeKey, onTabChange, tabs]
  )

  // Rendered width, not the preference: the sheet is phone-wide, where a stored 700px dock would draw five labels into ~390px.
  const showEveryLabel = !isMobile && width > DOCK_LABEL_WIDTH
  const panelId = `${uid}-panel`
  const tabId = (key: string) => `${uid}-tab-${key}`
  // The roving tab stop: the active tab, or the first, so a strip whose caller selected nothing is still reachable.
  const focusKey = active?.key ?? tabs[0]?.key
  const body = typeof children === 'function' ? children(width) : children
  // A dialog only where the panel is an OVERLAY: above `wide:` the same node is an ordinary column, and its close button and scrim are both `wide:hidden`.
  const modal = !vacant && open && overlayBand
  // Only where the reported width is the width on screen: in the phone-wide sheet it would rewrite the desktop preference for nothing.
  const resizeHandle = isMobile ? null : (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={width}
      aria-valuemin={DOCK_WIDTH_MIN}
      aria-valuemax={DOCK_WIDTH_MAX}
      tabIndex={0}
      onPointerDown={startDrag}
      onKeyDown={onHandleKey}
      className={dragging ? HANDLE_DRAGGING : HANDLE_IDLE}
    />
  )

  // ONE tree across every status: `body` keeps a single position, so crossing the `vacant` boundary reconciles it instead of remounting the panel that owns the fetch.
  return (
    <>
      <div className={!vacant && open ? TRACK_OVERLAY : TRACK} data-dock-track="">
        {/* Vacant, the track is the whole dock: the gutter it reserves is the reader's to narrow, and inside a `wide:`-only box the handle is reachable in exactly the band where the width means anything. */}
        {vacant ? resizeHandle : null}
        {/* Vacant: mounted and undrawn — unmounting would silence the next verdict and lose the panel's scroll position; preflight's `[hidden]` is `!important`, and dropping `PANEL` describes no box either. */}
        <div
          ref={panelRef}
          tabIndex={-1}
          hidden={vacant}
          role={modal ? 'dialog' : undefined}
          aria-modal={modal ? true : undefined}
          aria-label={modal ? label : undefined}
          className={vacant ? 'hidden' : PANEL}
        >
          {vacant ? null : resizeHandle}
          {vacant ? null : (
            <div className="flex flex-none items-center border-b border-(--border-subtle) pl-[5px]">
              {/* Zero gap between tabs by design; the strip scrolls rather than wraps. */}
              <div
                role="tablist"
                aria-label={label}
                ref={stripRef}
                onKeyDown={onStripKey}
                className="flex min-w-0 flex-1 gap-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {tabs.map((tab) => {
                  const on = tab.key === activeKey
                  const showLabel = showEveryLabel || on
                  const badge = tab.badge === undefined || tab.badge === '' ? null : tab.badge
                  // Named by its content where readable, so the pill reaches the name; a collapsed label is restored here, badge included.
                  const name = badge === null ? tab.label : `${tab.label} ${badge}`
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      id={tabId(tab.key)}
                      aria-controls={panelId}
                      aria-selected={on}
                      aria-label={showLabel ? undefined : name}
                      tabIndex={tab.key === focusKey ? 0 : -1}
                      data-dock-tab={tab.key}
                      title={tab.title ?? (showLabel ? undefined : tab.label)}
                      onClick={() => onTabChange(tab.key)}
                      className={on ? TAB_ON : TAB_OFF}
                    >
                      <Icon name={tab.icon} size={14} />
                      {showLabel ? <span data-dock-label="">{tab.label}</span> : null}
                      {badge === null ? null : <span className={on ? BADGE_ON : BADGE_OFF}>{badge}</span>}
                      {on ? (
                        <span
                          aria-hidden="true"
                          data-dock-indicator=""
                          className="absolute right-0 bottom-0 left-0 h-[2px] bg-(--brand)"
                        />
                      ) : null}
                    </button>
                  )
                })}
              </div>
              {/* Never scrolls with the strip: the action is the active tab's, and overflow must stay reachable however many tabs there are. */}
              <div className="flex flex-none items-center gap-px px-[6px]">
                {active?.actionIcon && active.actionLabel ? (
                  <button
                    type="button"
                    aria-label={active.actionLabel}
                    title={active.actionLabel}
                    data-dock-action={active.key}
                    onClick={() => onTabAction?.(active.key)}
                    className={ACTION_BTN}
                  >
                    <Icon name={active.actionIcon} size={15} />
                  </button>
                ) : null}
                {onOverflow ? (
                  <button
                    type="button"
                    aria-label="More"
                    title="More"
                    aria-haspopup="true"
                    data-dock-overflow=""
                    onClick={onOverflow}
                    className={ACTION_BTN}
                  >
                    <Icon name="ellipsis" size={15} />
                  </button>
                ) : null}
                {/* The overlay covers its own trigger, so the close control rides here; above `wide:` the dock is the column and closes nothing. */}
                <button
                  type="button"
                  aria-label="Close panels"
                  title="Close panels"
                  data-dock-close=""
                  onClick={closeOverlay}
                  className={`${ACTION_BTN} wide:hidden`}
                >
                  <Icon name="x" size={15} />
                </button>
              </div>
            </div>
          )}
          <div
            role={vacant ? undefined : 'tabpanel'}
            id={panelId}
            aria-labelledby={!vacant && active ? tabId(active.key) : undefined}
            className="flex min-h-0 flex-1 flex-col"
          >
            {/* Which of the two it is, is the whole difference between "wait" and "there is nothing here". */}
            {!vacant && activeStatus === 'loading' ? (
              <div role="status" data-dock-loading="" className={PLACEHOLDER}>
                <Icon name="loader" size={15} className="animate-spin" />
                Loading…
              </div>
            ) : null}
            {!vacant && activeStatus === 'empty' ? (
              <div data-dock-empty="" className={PLACEHOLDER}>
                Nothing to show
              </div>
            ) : null}
            {body}
          </div>
        </div>
      </div>
      {/* 769px–`wide:`: a floating top-right button opened by CLICK, no CSS hover/focus reveal — see the latch above for why. */}
      {vacant ? null : (
        <div className="fixed top-[10px] right-[14px] z-40 hidden desktop:max-wide:block">
          <button
            type="button"
            data-dock-trigger=""
            aria-label={label}
            aria-haspopup="true"
            aria-expanded={open}
            onClick={toggleOverlay}
            className={open ? TRIGGER_ON : TRIGGER_OFF}
          >
            <Icon name="panel-right" size={16} />
          </button>
        </div>
      )}
      {/* Tap-away close for both collapsed bands, so a latch is never a trap; under the panel and over the app bar, so a tap there closes too. */}
      {!vacant && open ? (
        <div data-dock-scrim="" className="fixed inset-0 z-30 wide:hidden" onClick={closeOverlay} aria-hidden="true" />
      ) : null}
    </>
  )
}
