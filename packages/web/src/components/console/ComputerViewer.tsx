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

export interface ComputerViewerProps {
  computer: ComputerDto
  // Injected by tests; the console opens a real session.
  createSession?: (deps: ConstructorParameters<typeof ComputerViewerSession>[0]) => ComputerViewerSession
}

export function ComputerViewerCard({
  computer,
  createSession,
  control
}: ComputerViewerProps & {
  // Who has control of the desktop, beside the title.
  control?: ReactNode
}) {
  const t = useTranslations('Computers.viewer')
  const ago = useAgo()
  const [open, setOpen] = useState(false)
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
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg" data-computer-viewer>
      <div className="cardhead gap-2">
        <span className="cardtitle flex-none">{t('title')}</span>
        <span className="ml-[6px] flex min-w-0 flex-1 items-center gap-[6px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {control}
        </span>
        {open ? (
          <Button variant="secondary" size="sm" className="flex-none" onClick={() => setOpen(false)}>
            {t('close')}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            className="flex-none"
            disabled={offline || asleep}
            onClick={() => setOpen(true)}
          >
            <Icon name="screen-share" size={14} />
            {t('watch')}
          </Button>
        )}
      </div>
      {open ? (
        <ComputerViewerScreen computer={computer} {...(createSession ? { createSession } : {})} />
      ) : (
        <div className="flex aspect-[16/10] flex-col items-center justify-center gap-[10px] bg-[#15111a] px-6">
          <Icon name={idle.icon} size={26} color="#6f6779" />
          <span className="max-w-[360px] text-center font-sans text-[13px] font-normal leading-[1.5] text-[#b8b0c4]">
            {idle.text}
          </span>
        </div>
      )}
      <div className="flex items-center gap-[7px] border-t border-(--border-subtle) px-4 py-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
        <Icon name="shield-check" size={13} className="flex-none" />
        <span>{t('privacy')}</span>
      </div>
    </div>
  )
}

export interface ComputerViewerScreenProps extends ComputerViewerProps {
  // The session dock's narrow column: tighter chrome.
  compact?: boolean
}

export function ComputerViewerScreen({ computer, createSession, compact = false }: ComputerViewerScreenProps) {
  const t = useTranslations('Computers.viewer')
  const [expanded, setExpanded] = useState(false)
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
  const session = useRef<ComputerViewerSession | null>(null)
  const [state, setState] = useState<ViewerState | null>(null)
  const [text, setText] = useState('')

  useEffect(() => {
    const deps = {
      computerId: computer.id,
      grant: () => openComputerViewer(computer.id),
      onState: setState,
      video: () => video.current
    }
    const created = createSession ? createSession(deps) : new ComputerViewerSession(deps)
    session.current = created
    void created.start()
    return () => {
      created.stop()
      session.current = null
    }
  }, [computer.id, createSession])

  const status = state?.status ?? null
  const inControl = status?.inControl ?? false
  const send = (input: ViewerInput) => session.current?.send(input) ?? Promise.resolve()
  const handlers = useInputHandlers(surface, status, send)

  const run = (action: () => Promise<void>) => {
    void action().finally(() => surface.current?.focus())
  }

  // Escape leaves the expanded view, except while driving: then it is the remote machine's key.
  useEffect(() => {
    if (!expanded || inControl) return
    const collapse = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', collapse)
    return () => window.removeEventListener('keydown', collapse)
  }, [expanded, inControl])
  // The expanded view leaves room for its toolbar and the control row under the screen.
  const screenSize = expanded ? 'block max-h-[calc(100vh-112px)] max-w-full' : 'block max-h-[70vh] max-w-full'

  const content = (
    <div
      className={expanded ? 'fixed inset-0 z-[70] flex flex-col bg-(--surface-app)' : undefined}
      data-viewer-expanded={expanded ? '' : undefined}
    >
      <div
        className={
          compact && !expanded
            ? 'flex flex-wrap items-center gap-2 border-b border-(--border-subtle) px-3 py-[7px]'
            : 'flex flex-wrap items-center gap-2 border-b border-(--border-subtle) px-4 py-[9px]'
        }
      >
        <StatusLine state={state} />
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
          {status?.mode === 'control' &&
            (inControl ? (
              <Button variant="danger" size="sm" onClick={() => run(() => session.current!.release())}>
                <Icon name="hand" size={14} />
                {t('release')}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => run(() => session.current!.takeControl())}>
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
                setExpanded((value) => !value)
                surface.current?.focus()
              }}
            >
              <Icon name={expanded ? 'minimize-2' : 'maximize-2'} size={14} />
            </Button>
          </span>
        </span>
      </div>
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
          expanded
            ? 'flex min-h-0 flex-1 items-center justify-center bg-[#111] p-2'
            : 'flex items-center justify-center bg-[#111] p-0 desktop:p-2'
        }
      >
        <div
          className={inControl ? 'relative leading-[0] outline-2 outline-(--status-online)' : 'relative leading-[0]'}
        >
          <video
            ref={attachVideo}
            autoPlay
            muted
            playsInline
            className={state?.path && state.path !== 'screenshots' ? screenSize : 'hidden'}
          />
          {state?.path === 'screenshots' && state.frameUrl && (
            <img src={state.frameUrl} alt={t('screenAlt')} className={screenSize} />
          )}
          {(!state || state.phase === 'connecting') && (
            <div className="flex h-60 w-full min-w-[280px] items-center justify-center font-sans text-[13px] text-[#cdd6e0]">
              {t('connecting')}
            </div>
          )}
          <div
            ref={surface}
            tabIndex={0}
            aria-label={t('surface')}
            data-viewer-surface
            className={inControl ? 'absolute inset-0 cursor-default outline-none' : 'absolute inset-0 outline-none'}
            {...handlers}
          />
        </div>
      </div>
      {inControl && (
        <div className="flex flex-wrap items-center gap-2 border-t border-(--border-subtle) px-4 py-[9px]">
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

function StatusLine({ state }: { state: ViewerState | null }) {
  const t = useTranslations('Computers.viewer')
  const status = state?.status
  let line = t('connecting')
  if (state?.phase === 'error') line = t('failed')
  else if (status?.unavailable) line = status.unavailable
  else if (status?.inControl) line = t('youInControl')
  else if (status?.paused) line = t('paused', { reason: status.paused.reason })
  else if (status?.lease) line = t('agentWorking', { holder: status.lease.holder })
  else if (status) line = status.mode === 'view' ? t('watchingOnly') : t('watching')
  return (
    <span
      className={
        status?.inControl
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
  send: (input: ViewerInput) => Promise<void>
) {
  const down = useRef<(Point & { button: (typeof BUTTONS)[number] }) | null>(null)
  const lastClick = useRef<{ at: number; button: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const moving = useRef<{ busy: boolean; next: Point | null }>({ busy: false, next: null })
  const wheel = useRef<{ delta: number; at: Point | null; timer: ReturnType<typeof setTimeout> | null }>({
    delta: 0,
    at: null,
    timer: null
  })
  const textBuffer = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: '', timer: null })
  const active = Boolean(status?.inControl)

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
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) }
  }
  const modifiers = (event: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) =>
    [event.ctrlKey && 'ctrl', event.shiftKey && 'shift', event.altKey && 'alt'].filter((m): m is string => Boolean(m))

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
      if (active && !down.current && event.pointerType === 'mouse') queueMove(point(event))
    },
    onPointerDown: (event: PointerEvent) => {
      surface.current?.focus()
      if (!active) return
      event.preventDefault()
      down.current = { ...point(event), button: BUTTONS[event.button] ?? 'left' }
    },
    onPointerUp: (event: PointerEvent) => {
      const start = down.current
      down.current = null
      if (!active || !start) return
      const end = point(event)
      const rect = surface.current!.getBoundingClientRect()
      const moved = Math.hypot((end.x - start.x) * rect.width, (end.y - start.y) * rect.height)
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
      w.delta += Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : 0
      w.at = point(event)
      if (w.timer) return
      w.timer = setTimeout(() => {
        w.timer = null
        const amount = Math.min(10, Math.max(1, Math.round(Math.abs(w.delta) / 60)))
        if (w.delta !== 0 && w.at) send({ type: 'scroll', ...w.at, direction: w.delta > 0 ? 'down' : 'up', amount })
        w.delta = 0
      }, 120)
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (!active || !status || event.nativeEvent.isComposing) return
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
    }
  }
}
