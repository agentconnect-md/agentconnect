'use client'

// The embedded viewer (computer-use.md §7, §10), on the Computer detail and in the session dock: watch, take over and release; media never crosses the CP.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { openComputerViewer, type ComputerDto } from '@/lib/api'
import { useAgo } from '@/lib/computers'
import { useAgentName } from '@/components/console/computer-members'
import { ComputerBrowserBar } from '@/components/console/ComputerBrowserBar'
import type { BrowserBarAction, BrowserViewerStatus } from '@agentconnect.md/protocol/computer-viewer'
import {
  ComputerViewerSession,
  keyToInput,
  type ViewerInput,
  type ViewerState,
  type ViewerStats,
  type ViewerStatus
} from '@/lib/computer-viewer'
import { Button, Icon } from '@/components/ui'

type Point = { x: number; y: number }

// `30 fps · 2.4 Mbps · 45 ms`, leaving out what the path cannot measure.
export function formatStats({ fps, kbps, latencyMs }: ViewerStats): string {
  const rate = kbps === null ? null : kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`
  return [fps === null ? null : `${fps} fps`, rate, latencyMs === null ? null : `${latencyMs} ms`]
    .filter(Boolean)
    .join(' · ')
}
const BUTTONS = ['left', 'middle', 'right'] as const

/** Which of a Computer's desktops to watch (computer-use.md §3.9); mount it only for a Computer that reports desktops. */
export function DesktopPicker({
  computer,
  value,
  onChange
}: {
  computer: ComputerDto
  value: string
  onChange: (desktop: string) => void
}) {
  const t = useTranslations('Computers.viewer')
  const agentName = useAgentName()
  if (!computer.desktops) return null
  return (
    <select
      className="inp w-auto min-w-0 max-w-[220px] flex-none"
      aria-label={t('desktop.pick')}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      data-desktop-picker
    >
      <option value="main">{t('desktop.main')}</option>
      {computer.desktops.map((desktop) => (
        <option key={desktop.id} value={desktop.id}>
          {t('desktop.agent', { agent: agentName(desktop.agentId, desktop.lease?.agentName) })}
        </option>
      ))}
    </select>
  )
}

/** The Computer detail's segmented desktop switch: each desktop with who works on it. */
export function DesktopTabs({
  computer,
  value,
  onChange
}: {
  computer: ComputerDto
  value: string
  onChange: (desktop: string) => void
}) {
  const t = useTranslations('Computers.viewer')
  const agentName = useAgentName()
  if (!computer.desktops) return null
  const online = computer.status !== 'offline' && computer.status !== 'revoked' && computer.status !== 'sleeping'
  const tabs = [
    {
      id: 'main',
      label: t('desktop.main'),
      sub: computer.lease ? agentName(computer.lease.agentId, computer.lease.agentName) : t('desktop.idle'),
      busy: Boolean(computer.lease)
    },
    ...computer.desktops.map((desktop) => ({
      id: desktop.id,
      label: t('desktop.agent', { agent: agentName(desktop.agentId, desktop.lease?.agentName) }),
      sub: desktop.lease ? t('desktop.working') : t('desktop.idle'),
      busy: Boolean(desktop.lease)
    }))
  ]
  return (
    <div
      role="tablist"
      aria-label={t('desktop.tabs')}
      className="inline-flex max-w-full min-w-0 flex-none items-center gap-[2px] overflow-x-auto rounded-[7px] bg-(--surface-sunken) p-[2px]"
      data-desktop-tabs
    >
      {tabs.map((tab) => {
        const selected = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            data-desktop-tab={tab.id}
            onClick={() => onChange(tab.id)}
            className={
              selected
                ? 'inline-flex h-6 flex-none cursor-pointer items-center gap-[6px] rounded-[5px] border-0 bg-(--surface-card) px-[9px] font-sans text-[12px] font-medium leading-normal whitespace-nowrap text-(--text-primary) shadow-(--shadow-sm)'
                : 'inline-flex h-6 flex-none cursor-pointer items-center gap-[6px] rounded-[5px] border-0 bg-transparent px-[9px] font-sans text-[12px] font-medium leading-normal whitespace-nowrap text-(--text-secondary) hover:text-(--text-primary)'
            }
          >
            <span
              className="dot h-[6px] w-[6px]"
              style={{ background: online && tab.busy ? 'var(--status-online)' : 'var(--border-strong)' }}
            />
            {tab.label}
            <span className="font-normal text-(--text-tertiary)">{tab.sub}</span>
          </button>
        )
      })}
    </div>
  )
}

/** The desktop to show: the chosen one while the Computer still runs it, else the main one. */
export const shownDesktop = (computer: ComputerDto, chosen: string): string =>
  chosen !== 'main' && computer.desktops?.some((desktop) => desktop.id === chosen) ? chosen : 'main'

export interface ComputerViewerProps {
  computer: ComputerDto
  // An agent desktop to watch (computer-use.md §3.9); absent or `main`, the main desktop.
  desktop?: string
  // Injected by tests; the console opens a real session.
  createSession?: (deps: ConstructorParameters<typeof ComputerViewerSession>[0]) => ComputerViewerSession
}

/** Take-over controls the screen hands up to a header that draws them. */
export interface ViewerControls {
  inControl: boolean
  take: () => void
  release: () => void
}

export function ComputerViewerCard({
  computer,
  createSession,
  control,
  desktop = 'main',
  onDesktop
}: ComputerViewerProps & {
  // Who has control of the desktop, beside the title.
  control?: ReactNode
  // Choosing another desktop; without it the desktop tabs are not shown.
  onDesktop?: (desktop: string) => void
}) {
  const t = useTranslations('Computers.viewer')
  const ago = useAgo()
  const [open, setOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [controls, setControls] = useState<ViewerControls | null>(null)
  const [modeTarget, setModeTarget] = useState<HTMLDivElement | null>(null)
  const offline = computer.status === 'revoked' || computer.status === 'offline'
  const asleep = computer.status === 'sleeping'
  const idle = offline
    ? {
        icon: 'monitor-off',
        text:
          computer.status === 'offline' && computer.lastSeenAt
            ? t('offlineSeen', { when: ago(computer.lastSeenAt) })
            : t('offline')
      }
    : asleep
      ? { icon: 'moon', text: t('asleep') }
      : { icon: 'monitor', text: t('idle') }
  const close = () => {
    setOpen(false)
    setFullscreen(false)
    setControls(null)
  }
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg" data-computer-viewer title={t('privacy')}>
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle flex-none">{t('title')}</span>
        {onDesktop && computer.desktops && <DesktopTabs computer={computer} value={desktop} onChange={onDesktop} />}
        <div className="empty:hidden" ref={setModeTarget} />
        <span className="ml-[6px] flex min-w-0 flex-1 items-center gap-[6px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {control}
        </span>
        <span className="ml-auto flex flex-none items-center gap-2">
          {!offline && !asleep && (
            <button
              type="button"
              className="iconbtn h-7 w-7"
              aria-label={t('fullscreen')}
              title={t('fullscreen')}
              data-viewer-fullscreen
              onClick={() => {
                setOpen(true)
                setFullscreen(true)
              }}
            >
              <Icon name="maximize-2" size={14} />
            </button>
          )}
          {open ? (
            <>
              {controls &&
                (controls.inControl ? (
                  <Button variant="secondary" size="sm" onClick={controls.release}>
                    <Icon name="undo-2" size={14} />
                    {t('release')}
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={controls.take}>
                    <Icon name="mouse-pointer-2" size={14} />
                    {t('takeControl')}
                  </Button>
                ))}
              <Button variant="secondary" size="sm" onClick={close}>
                {t('close')}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="sm" disabled={offline || asleep} onClick={() => setOpen(true)}>
              <Icon name="screen-share" size={14} />
              {t('watch')}
            </Button>
          )}
        </span>
      </div>
      {open ? (
        <ComputerViewerScreen
          key={desktop}
          computer={computer}
          desktop={desktop}
          overlay
          modeTarget={modeTarget}
          expanded={fullscreen}
          onExpanded={setFullscreen}
          onControls={setControls}
          {...(createSession ? { createSession } : {})}
        />
      ) : (
        <div className="flex aspect-[16/10] flex-col items-center justify-center gap-[10px] bg-[#15111a] px-6">
          <Icon name={idle.icon} size={26} color="#6f6779" />
          <span className="max-w-[360px] text-center font-sans text-[13px] font-normal leading-[1.5] text-[#b8b0c4]">
            {idle.text}
          </span>
        </div>
      )}
    </div>
  )
}

export interface ComputerViewerScreenProps extends ComputerViewerProps {
  // The session dock's narrow column: tighter chrome.
  compact?: boolean
  preferBrowser?: boolean
  modeTarget?: HTMLDivElement | null
  // The detail card: status and stats as chips over the screen, take-over in the card header, real full screen.
  overlay?: boolean
  // Controlled expanded (full screen) state; uncontrolled without it.
  expanded?: boolean
  onExpanded?: (expanded: boolean) => void
  onControls?: (controls: ViewerControls | null) => void
}

export function ComputerViewerScreen({
  computer,
  createSession,
  compact = false,
  preferBrowser = false,
  modeTarget,
  overlay = false,
  desktop = 'main',
  expanded: expandedProp,
  onExpanded,
  onControls
}: ComputerViewerScreenProps) {
  const t = useTranslations('Computers.viewer')
  const [ownExpanded, setOwnExpanded] = useState(false)
  const expanded = expandedProp ?? ownExpanded
  const setExpanded = useCallback(
    (value: boolean) => (onExpanded ? onExpanded(value) : setOwnExpanded(value)),
    [onExpanded]
  )
  const video = useRef<HTMLVideoElement>(null)
  // The stream outlives the <video> element, which moving into or out of the expanded portal recreates.
  const stream = useRef<MediaProvider | null>(null)
  // On every path in or out (button, Escape, anything later), the leaving element hands its stream to the arriving one.
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    if (element) {
      if (!element.srcObject && stream.current) element.srcObject = stream.current
    } else if (video.current?.srcObject) {
      stream.current = video.current.srcObject
    }
    video.current = element
  }, [])
  const surface = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const session = useRef<ComputerViewerSession | null>(null)
  const [state, setState] = useState<ViewerState | null>(null)
  const [browser, setBrowser] = useState<BrowserViewerStatus | null>(null)
  const [mode, setMode] = useState<'desktop' | 'browser' | null>(null)
  const [text, setText] = useState('')
  const browserMode = mode === 'browser' && Boolean(browser?.available)
  const probeBrowser = computer.os === 'linux' && computer.isolation !== 'none'

  useEffect(() => {
    if (preferBrowser && browser?.available && browser.running) setMode((previous) => previous ?? 'browser')
  }, [preferBrowser, browser?.available, browser?.running])

  useEffect(() => {
    setState(null)
    stream.current = null
    let active = true
    const deps = {
      computerId: computer.id,
      ...(desktop !== 'main' ? { desktop } : {}),
      ...(probeBrowser ? { probeBrowser } : {}),
      ...(browserMode
        ? { browser: compact ? { maxWidth: 640, maxHeight: 512 } : { maxWidth: 1280, maxHeight: 1024 } }
        : {}),
      grant: () => openComputerViewer(computer.id, desktop),
      onState: (next: ViewerState) => {
        if (!active) return
        setState(next)
        if (next.browser) setBrowser(next.browser)
      },
      video: () => video.current
    }
    const created = createSession ? createSession(deps) : new ComputerViewerSession(deps)
    session.current = created
    void created.start()
    return () => {
      active = false
      created.stop()
      session.current = null
    }
  }, [computer.id, desktop, createSession, compact, browserMode, probeBrowser])

  const status = state?.status ?? null
  const inControl = status?.inControl ?? false
  const canControl = status?.mode === 'control'
  const current = session.current
  const send = (input: ViewerInput) => current?.send(input) ?? Promise.resolve()
  const act = (action: BrowserBarAction) => session.current?.browserAction(action) ?? Promise.resolve(false)
  const browserInput = browserMode && Boolean(state?.frameUrl) && !browser?.dialog
  const showScreen = !browserMode || Boolean(browser?.frontPageId)
  const handlers = useInputHandlers(surface, status, send, browserMode, browserInput)

  const run = useCallback((action: () => Promise<void>) => {
    void action().finally(() => surface.current?.focus())
  }, [])
  const take = useCallback(() => run(() => session.current!.takeControl()), [run])
  const release = useCallback(() => run(() => session.current!.release()), [run])

  useEffect(() => {
    onControls?.(canControl ? { inControl, take, release } : null)
  }, [onControls, canControl, inControl, take, release])
  useEffect(() => () => onControls?.(null), [onControls])

  // Escape leaves the expanded view, except while driving: then it is the remote machine's key.
  useEffect(() => {
    if (!expanded || inControl) return
    const collapse = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', collapse)
    return () => window.removeEventListener('keydown', collapse)
  }, [expanded, inControl, setExpanded])

  // The card's full screen is the browser's own; leaving it (Esc included) collapses the view.
  useEffect(() => {
    if (!overlay || !expanded) return
    const element = frame.current
    if (element?.requestFullscreen && !document.fullscreenElement) void element.requestFullscreen().catch(() => {})
    const left = () => {
      if (!document.fullscreenElement) setExpanded(false)
    }
    document.addEventListener('fullscreenchange', left)
    return () => {
      document.removeEventListener('fullscreenchange', left)
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {})
    }
  }, [overlay, expanded, setExpanded])

  // The expanded view leaves room for its toolbar and the control row under the screen.
  const screenSize = expanded
    ? browserMode
      ? 'block max-h-[calc(100dvh-220px)] max-w-full'
      : 'block max-h-[calc(100vh-112px)] max-w-full'
    : 'block max-h-[70vh] max-w-full'
  const line = statusLine(t, state)
  // An agent desktop's size is its own, so only the main desktop names one.
  const display = desktop === 'main' ? computer.capabilities.displays[0] : undefined
  const live = Boolean(status) && !status?.unavailable && state?.phase !== 'error'

  const toolbar = (
    <div
      className={
        compact && !expanded
          ? 'flex flex-wrap items-center gap-2 border-b border-(--border-subtle) px-3 py-[7px]'
          : 'flex flex-wrap items-center gap-2 border-b border-(--border-subtle) px-4 py-[9px]'
      }
    >
      <StatusLine line={line} inControl={inControl} />
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {state?.path && state.stats && (
          <span
            className="font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary) tabular-nums"
            title={t(state.path === 'screenshots' ? 'stats.frameTime' : 'stats.roundTrip')}
            data-viewer-stats
          >
            {formatStats(state.stats)}
          </span>
        )}
        {state?.path && (
          <span className="badge" title={state.notes.join('\n') || undefined} data-viewer-path={state.path}>
            <Icon name={state.path === 'screenshots' ? 'image' : 'radio-tower'} size={12} />
            {t(`path.${state.path}`)}
          </span>
        )}
        {canControl &&
          (inControl ? (
            <Button variant="danger" size="sm" onClick={release}>
              <Icon name="hand" size={14} />
              {t('release')}
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={take}>
              <Icon name="hand" size={14} />
              {t('takeControl')}
            </Button>
          ))}
        <span title={expanded ? t('collapse') : t('expand')} data-viewer-expand>
          <Button
            variant="secondary"
            size="sm"
            ariaLabel={expanded ? t('collapse') : t('expand')}
            onClick={() => {
              setExpanded(!expanded)
              surface.current?.focus()
            }}
          >
            <Icon name={expanded ? 'minimize-2' : 'maximize-2'} size={14} />
          </Button>
        </span>
      </span>
    </div>
  )

  // Full screen on the detail card: one floating bar with the name, take-over and the way out.
  const floating = (
    <div className="absolute top-3 left-1/2 z-[1] flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-[9px] bg-(--surface-card) px-2 py-[6px] shadow-(--shadow-lg)">
      <span className="min-w-0 truncate px-1 font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
        {computer.name}
      </span>
      {canControl &&
        (inControl ? (
          <Button variant="secondary" size="sm" onClick={release}>
            <Icon name="undo-2" size={14} />
            {t('release')}
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={take}>
            <Icon name="mouse-pointer-2" size={14} />
            {t('takeControl')}
          </Button>
        ))}
      <Button variant="secondary" size="sm" onClick={() => setExpanded(false)}>
        <Icon name="minimize-2" size={14} />
        {t('exitFullscreen')}
      </Button>
    </div>
  )

  const chip =
    'inline-flex items-center gap-[6px] rounded-[6px] bg-black/70 px-2 py-[3px] font-sans text-[11.5px] font-medium leading-normal text-[#ece8f1]'
  const chips = (
    <>
      <span className={`pointer-events-none absolute top-2 left-2 ${chip}`} title={line} data-viewer-status>
        <span
          className="dot h-[6px] w-[6px]"
          style={{
            background: inControl ? 'var(--brand)' : live ? 'var(--status-online)' : 'var(--text-tertiary)'
          }}
        />
        {inControl ? t('controlling') : live ? t('live') : line}
      </span>
      {state?.path && (
        <span
          className={
            inControl ? `pointer-events-none absolute top-2 right-2 ${chip}` : `absolute top-2 right-2 ${chip}`
          }
        >
          {display && (
            <span className="font-mono font-normal tabular-nums" data-viewer-resolution>
              {display.width}×{display.height}
            </span>
          )}
          {state.stats && (
            <span
              className="font-mono font-normal tabular-nums"
              title={t(state.path === 'screenshots' ? 'stats.frameTime' : 'stats.roundTrip')}
              data-viewer-stats
            >
              {formatStats(state.stats)}
            </span>
          )}
          <span
            className="inline-flex items-center gap-1"
            title={state.notes.join('\n') || undefined}
            data-viewer-path={state.path}
          >
            <Icon name={state.path === 'screenshots' ? 'image' : 'radio-tower'} size={12} />
            {t(`path.${state.path}`)}
          </span>
        </span>
      )}
      {inControl && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-[6px] bg-(--brand) px-3 py-[5px] font-sans text-[12px] font-medium leading-normal text-(--text-inverse)">
          <Icon name="mouse-pointer-2" size={12} />
          {t('inControlBar')}
        </span>
      )}
    </>
  )

  const modeSwitch = browser?.available ? (
    <div className="flex gap-1" role="group" aria-label={t('browser.view')}>
      <Button
        variant={browserMode ? 'secondary' : 'primary'}
        size="xs"
        ariaPressed={!browserMode}
        onClick={() => setMode('desktop')}
      >
        {t('browser.desktop')}
      </Button>
      <Button
        variant={browserMode ? 'primary' : 'secondary'}
        size="xs"
        ariaPressed={browserMode}
        onClick={() => setMode('browser')}
      >
        {t('browser.title')}
      </Button>
    </div>
  ) : null

  const content = (
    <div
      ref={frame}
      className={expanded ? 'fixed inset-0 z-[70] flex flex-col bg-(--surface-app)' : undefined}
      data-viewer-expanded={expanded ? '' : undefined}
    >
      {(!overlay || (expanded && browserMode)) && toolbar}
      {modeSwitch &&
        (modeTarget && !expanded ? (
          createPortal(modeSwitch, modeTarget)
        ) : (
          <div className="border-b border-(--border-subtle) bg-(--surface-card) px-2 py-1.5">{modeSwitch}</div>
        ))}
      {browserMode && browser && <ComputerBrowserBar browser={browser} canControl={canControl} act={act} />}
      {state?.error && (
        <div
          role="alert"
          className="border-b border-(--border-subtle) bg-(--status-error-soft) px-4 py-[7px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)"
        >
          {state.error}
        </div>
      )}
      <div
        className={
          !showScreen
            ? 'hidden'
            : expanded
              ? 'relative flex min-h-0 flex-1 items-center justify-center bg-[#111] p-2'
              : 'relative flex items-center justify-center bg-[#111] p-0 desktop:p-2'
        }
      >
        <div
          className={
            inControl && !overlay
              ? 'relative min-w-0 max-w-full leading-[0] outline-2 outline-(--status-online)'
              : 'relative min-w-0 max-w-full leading-[0]'
          }
        >
          <video
            ref={attachVideo}
            autoPlay
            muted
            playsInline
            className={!browserMode && state?.path && state.path !== 'screenshots' ? screenSize : 'hidden'}
          />
          {(browserMode || state?.path === 'screenshots') && state?.frameUrl && (
            <img
              src={state.frameUrl}
              alt={browserMode ? t('browser.screenAlt') : t('screenAlt')}
              className={screenSize}
            />
          )}
          {(!state || state.phase === 'connecting' || (browserMode && !state.frameUrl && state.phase === 'live')) && (
            <div className="flex h-60 w-full min-w-[280px] items-center justify-center font-sans text-[13px] text-[#cdd6e0]">
              {t('connecting')}
            </div>
          )}
          <div
            ref={surface}
            tabIndex={0}
            aria-label={browserMode ? t('browser.surface') : t('surface')}
            data-viewer-surface
            className={
              browserInput && canControl
                ? 'absolute inset-0 cursor-default touch-none outline-none'
                : inControl
                  ? 'absolute inset-0 cursor-default outline-none'
                  : 'absolute inset-0 outline-none'
            }
            {...handlers}
          />
        </div>
        {overlay && chips}
        {overlay && expanded && !browserMode && floating}
      </div>
      {showScreen && (browserMode ? canControl && browserInput : inControl) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-(--border-subtle) bg-(--surface-card) px-4 py-[9px]">
          <Button variant="secondary" size="xs" onClick={() => send({ type: 'key', keys: ['escape'] })}>
            Esc
          </Button>
          {status?.os === 'windows' && (
            <Button variant="secondary" size="xs" onClick={() => send({ type: 'key', keys: ['win'] })}>
              Win
            </Button>
          )}
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (text) send({ type: 'type', text })
              setText('')
              surface.current?.focus()
            }}
          >
            <input
              className="inp min-w-0 flex-1"
              value={text}
              placeholder={t('textPlaceholder')}
              onChange={(event) => setText(event.target.value)}
            />
            <Button variant="secondary" size="xs" type="submit">
              <Icon name="send" size={13} />
              {t('send')}
            </Button>
          </form>
        </div>
      )}
    </div>
  )
  // Expanded, it renders on the page body: the dock's fixed panel is a stacking context no z-index inside it can leave.
  return expanded ? createPortal(content, document.body) : content
}

// The one-line state of the viewer: connecting, failed, who drives, or plain watching.
function statusLine(t: ReturnType<typeof useTranslations<'Computers.viewer'>>, state: ViewerState | null): string {
  const status = state?.status
  if (state?.phase === 'error') return t('failed')
  if (status?.unavailable) return status.unavailable
  if (status?.inControl) return t('youInControl')
  if (status?.paused) return t('paused', { reason: status.paused.reason })
  if (status?.lease) return t('agentWorking', { holder: status.lease.holder })
  if (status) return status.mode === 'view' ? t('watchingOnly') : t('watching')
  return t('connecting')
}

function StatusLine({ line, inControl }: { line: string; inControl: boolean }) {
  return (
    <span
      className={
        inControl
          ? 'font-sans text-[12.5px] font-semibold leading-normal text-(--status-online)'
          : 'font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)'
      }
      data-viewer-status
    >
      {line}
    </span>
  )
}

// Pointer, wheel and keyboard on the screen surface become viewer input while the member holds control.
function useInputHandlers(
  surface: React.RefObject<HTMLDivElement | null>,
  status: ViewerStatus | null,
  send: (input: ViewerInput) => Promise<void>,
  browserMode: boolean,
  browserInput: boolean
) {
  const down = useRef<(Point & { button: (typeof BUTTONS)[number] }) | null>(null)
  const lastClick = useRef<{ at: number; button: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const moving = useRef<{ busy: boolean; next: Point | null }>({ busy: false, next: null })
  const wheel = useRef<{ x: number; y: number; at: Point | null; timer: ReturnType<typeof setTimeout> | null }>({
    x: 0,
    y: 0,
    at: null,
    timer: null
  })
  const textBuffer = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: '', timer: null })
  const active = browserMode ? browserInput && status?.mode === 'control' : Boolean(status?.inControl)

  useEffect(() => {
    const pointer = moving.current
    const scroll = wheel.current
    const buffer = textBuffer.current
    return () => {
      if (lastClick.current) clearTimeout(lastClick.current.timer)
      if (scroll.timer) clearTimeout(scroll.timer)
      if (buffer.timer) clearTimeout(buffer.timer)
      down.current = null
      lastClick.current = null
      pointer.next = null
      scroll.x = 0
      scroll.y = 0
      scroll.timer = null
      buffer.text = ''
      buffer.timer = null
    }
  }, [browserMode, active])

  // React's wheel listener is passive, so a native one keeps the page from scrolling while the member drives.
  useEffect(() => {
    const element = surface.current
    if (!element || !active) return
    const stop = (event: globalThis.WheelEvent) => event.preventDefault()
    element.addEventListener('wheel', stop, { passive: false })
    return () => element.removeEventListener('wheel', stop)
  }, [surface, active])

  const point = (event: { clientX: number; clientY: number }): Point => {
    const rect = surface.current!.getBoundingClientRect()
    const clamp = (v: number) => Math.min(Math.max(v, 0), 1)
    return {
      x: clamp((event.clientX - rect.left) / Math.max(rect.width, 1)),
      y: clamp((event.clientY - rect.top) / Math.max(rect.height, 1))
    }
  }
  const modifiers = (event: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) =>
    [event.ctrlKey && 'ctrl', event.shiftKey && 'shift', event.altKey && 'alt'].filter((m): m is string => Boolean(m))
  const scrollAt = (at: Point, x: number, y: number) => {
    const horizontal = Math.abs(x) > Math.abs(y)
    const delta = horizontal ? x : y
    if (delta === 0) return
    const amount = Math.min(10, Math.max(1, Math.round(Math.abs(delta) / 60)))
    const direction = horizontal ? (delta > 0 ? 'right' : 'left') : delta > 0 ? 'down' : 'up'
    return send({ type: 'scroll', ...at, direction, amount })
  }

  // Hover sends only the latest position, after the previous move is applied: inputs are serial, so a timer outruns the round trip.
  const queueMove = (p: Point) => {
    moving.current.next = p
    if (moving.current.busy) return
    moving.current.busy = true
    const target = moving.current.next
    moving.current.next = null
    void send({ type: 'move', ...target }).finally(() => {
      moving.current.busy = false
      if (moving.current.next) queueMove(moving.current.next)
    })
  }

  const flushText = () => {
    const buffer = textBuffer.current
    if (buffer.timer) clearTimeout(buffer.timer)
    buffer.timer = null
    if (buffer.text) send({ type: 'type', text: buffer.text })
    buffer.text = ''
  }

  return {
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
    onPointerMove: (event: PointerEvent) => {
      if (active && status?.inControl && !down.current && event.pointerType === 'mouse') queueMove(point(event))
    },
    onPointerDown: (event: PointerEvent) => {
      surface.current?.focus()
      if (!active) return
      event.preventDefault()
      down.current = { ...point(event), button: BUTTONS[event.button] ?? 'left' }
    },
    onPointerCancel: () => {
      down.current = null
    },
    onPointerUp: (event: PointerEvent) => {
      const start = down.current
      down.current = null
      if (!active || !start) return
      const end = point(event)
      const rect = surface.current!.getBoundingClientRect()
      const x = (end.x - start.x) * rect.width
      const y = (end.y - start.y) * rect.height
      const moved = Math.hypot(x, y)
      if (moved > 5 && browserMode && event.pointerType === 'touch') return scrollAt(start, -x, -y)
      if (moved > 5 && start.button === 'left') return send({ type: 'drag', from: { x: start.x, y: start.y }, to: end })
      const mods = modifiers(event)
      // Two quick clicks become one double click, so the remote OS sees a pair despite network latency.
      const last = lastClick.current
      if (last && event.timeStamp - last.at < 350 && last.button === start.button) {
        clearTimeout(last.timer)
        lastClick.current = null
        return send({ type: 'click', x: start.x, y: start.y, button: start.button, count: 2, modifiers: mods })
      }
      lastClick.current = {
        at: event.timeStamp,
        button: start.button,
        timer: setTimeout(() => {
          lastClick.current = null
          send({ type: 'click', x: start.x, y: start.y, button: start.button, modifiers: mods })
        }, 300)
      }
    },
    onWheel: (event: WheelEvent) => {
      if (!active) return
      const w = wheel.current
      if (Math.abs(event.deltaY) >= Math.abs(event.deltaX)) w.y += event.deltaY
      else if (browserMode) w.x += event.deltaX
      w.at = point(event)
      if (w.timer) return
      w.timer = setTimeout(() => {
        w.timer = null
        if (w.at) scrollAt(w.at, w.x, w.y)
        w.x = 0
        w.y = 0
      }, 120)
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (!active || !status || event.nativeEvent.isComposing) return
      if (browserMode && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return
      const input = keyToInput(event, status.os)
      if (!input) return
      event.preventDefault()
      if (input.type === 'char') {
        textBuffer.current.text += input.text
        textBuffer.current.timer ??= setTimeout(flushText, 40)
        return
      }
      flushText()
      send(input)
    },
    onPaste: (event: React.ClipboardEvent) => {
      if (!browserMode || !active) return
      const text = event.clipboardData.getData('text/plain')
      if (!text) return
      event.preventDefault()
      flushText()
      send({ type: 'type', text })
    }
  }
}
