'use client'

// Finding your place in a long transcript: the NEW line over what arrived since you last read it, and the turn map at its right edge.

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

/** Most ticks the map draws; a longer transcript is sampled evenly, its newest turn always kept. */
export const MAP_TICKS_MAX = 40

/** Above the first turn that arrived after this browser last read the transcript. */
export function NewDivider() {
  const t = useTranslations('Sessions.detail.transcriptNav')
  return (
    <div
      data-new-divider=""
      role="separator"
      aria-label={t('newSince')}
      className="flex items-center gap-3 font-mono text-[11px] font-semibold leading-normal tracking-[.08em] text-(--brand) after:h-px after:flex-1 after:bg-(--brand) after:opacity-50"
    >
      {t('new')}
    </div>
  )
}

/** Advances the read record to the newest turn while it is on screen; renders nothing. */
export function SeenRecorder({ newestMs, markSeen }: { newestMs: number | null; markSeen: (at: number) => void }) {
  useEffect(() => {
    if (newestMs !== null) markSeen(newestMs)
  }, [markSeen, newestMs])
  return null
}

export interface MapTurn {
  key: string
  tip: string
}

/** Which turns the map draws: all of them up to the cap, else an even sample that keeps the newest. */
export function mapTicks<T>(turns: readonly T[], max = MAP_TICKS_MAX): T[] {
  if (turns.length <= max) return [...turns]
  const step = (turns.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => turns[Math.round(i * step)]!)
}

/** One tick per turn at the transcript's right edge: the one in view is the long one, a hover names it, and a tick scrolls to its turn. */
export function TranscriptMap({ turns, onJump }: { turns: readonly MapTurn[]; onJump?: () => void }) {
  const t = useTranslations('Sessions.detail.transcriptNav')
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const [hover, setHover] = useState<{ key: string; top: number } | null>(null)
  // While a jump scrolls, the target stays marked rather than every turn it passes.
  const jumping = useRef<string | null>(null)
  const ticks = mapTicks(turns)

  useEffect(() => {
    const scroller = ref.current?.parentElement?.querySelector<HTMLElement>('[data-transcript-scroll]')
    if (!scroller) return
    let frame = 0
    // The turn in view is the one at the pane's top, where a jump lands it; at the end it is the last turn, which may never reach the top.
    const measure = () => {
      frame = 0
      if (jumping.current) return
      const anchors = [...scroller.querySelectorAll<HTMLElement>('[data-turn-anchor]')]
      const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4
      const line = scroller.getBoundingClientRect().top + 24
      let current: string | null = anchors[0]?.dataset.turnAnchor ?? null
      for (const el of anchors) {
        if (el.getBoundingClientRect().top <= line) current = el.dataset.turnAnchor ?? null
        else break
      }
      if (atEnd && anchors.length) current = anchors[anchors.length - 1]!.dataset.turnAnchor ?? null
      setActive(current)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const settle = () => {
      jumping.current = null
      measure()
    }
    measure()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('scrollend', settle)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('scrollend', settle)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [turns.length])

  // A smooth scroll the bottom-follow has let go of, so nothing pulls it back before it lands.
  const go = (key: string) => {
    const scroller = ref.current?.parentElement?.querySelector<HTMLElement>('[data-transcript-scroll]')
    const el = scroller?.querySelector<HTMLElement>(`[data-turn-anchor="${CSS.escape(key)}"]`)
    setActive(key)
    if (!scroller || !el) return
    onJump?.()
    jumping.current = key
    window.setTimeout(() => {
      if (jumping.current === key) jumping.current = null
    }, 1500)
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16
    scroller.scrollTo({ top, behavior: 'smooth' })
  }

  if (ticks.length < 3) return null
  // The tick to mark: the turn in view, or the drawn tick nearest before it when the map samples.
  const order = new Map(turns.map((turn, i) => [turn.key, i]))
  const activeIndex = active !== null ? (order.get(active) ?? -1) : -1
  const markedKey = ticks.reduce<string | null>(
    (best, tick) => ((order.get(tick.key) ?? -1) <= activeIndex ? tick.key : best),
    null
  )
  const hovered = hover ? ticks.find((tick) => tick.key === hover.key) : undefined

  return (
    <div
      ref={ref}
      data-transcript-map=""
      aria-label={t('map')}
      className="absolute top-1/2 right-[10px] z-[4] hidden -translate-y-1/2 flex-col items-center px-1 py-2 desktop:flex"
      // Hover follows the nearest tick anywhere in the map, so the pointer between two ticks still names one of them.
      onMouseMove={(event) => {
        const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
        let near: HTMLButtonElement | undefined
        let best = Infinity
        for (const row of rows) {
          const box = row.getBoundingClientRect()
          const d = Math.abs(event.clientY - (box.top + box.height / 2))
          if (d < best) {
            best = d
            near = row
          }
        }
        const key = near?.dataset.tick
        if (near && key && key !== hover?.key) setHover({ key, top: near.offsetTop + near.offsetHeight / 2 })
      }}
      onMouseLeave={() => setHover(null)}
    >
      {ticks.map((tick) => {
        const on = tick.key === markedKey
        const pointed = tick.key === hover?.key
        const show = (event: { currentTarget: HTMLButtonElement }) =>
          setHover({ key: tick.key, top: event.currentTarget.offsetTop + event.currentTarget.offsetHeight / 2 })
        return (
          // A 7px row around a 3px bar: the bar keeps Orca's spacing while the row is easy to point at.
          <button
            key={tick.key}
            type="button"
            aria-label={tick.tip}
            aria-current={on ? 'true' : undefined}
            data-tick={tick.key}
            onClick={() => go(tick.key)}
            onFocus={show}
            onBlur={() => setHover(null)}
            className="flex h-[7px] w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0"
          >
            {/* Every tick the same short mark; the turn in view is a little longer, centred on the column as Orca draws it. */}
            <span
              aria-hidden
              className={`h-[3px] rounded-[2px] transition-colors ${
                on ? 'w-[18px] bg-(--text-primary)' : pointed ? 'w-3 bg-(--text-tertiary)' : 'w-3 bg-(--border-strong)'
              }`}
            />
          </button>
        )
      })}
      {hovered && hover ? (
        <div
          role="tooltip"
          data-transcript-map-tip=""
          style={{ top: hover.top }}
          className="pointer-events-none absolute right-full mr-2 w-max max-w-[300px] -translate-y-1/2 rounded-[8px] border border-(--border-default) bg-(--surface-card) px-[10px] py-[6px] font-sans text-[12.5px] font-normal leading-[1.45] text-(--text-primary) shadow-(--shadow-md) [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
        >
          {hovered.tip}
        </div>
      ) : null}
    </div>
  )
}
