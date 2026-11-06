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
  /** A person's message reads as a short tick, an agent's turn as a long one. */
  human: boolean
  tip: string
}

/** Which turns the map draws: all of them up to the cap, else an even sample that keeps the newest. */
export function mapTicks<T>(turns: readonly T[], max = MAP_TICKS_MAX): T[] {
  if (turns.length <= max) return [...turns]
  const step = (turns.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => turns[Math.round(i * step)]!)
}

/** One tick per turn at the transcript's right edge: the one in view is marked, and a tick scrolls to its turn. */
export function TranscriptMap({ turns }: { turns: readonly MapTurn[] }) {
  const t = useTranslations('Sessions.detail.transcriptNav')
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const ticks = mapTicks(turns)

  useEffect(() => {
    const scroller = ref.current?.parentElement?.querySelector<HTMLElement>('[data-transcript-scroll]')
    if (!scroller) return
    let frame = 0
    // The turn in view is the last one whose top is above 45% of the pane.
    const measure = () => {
      frame = 0
      const top = scroller.getBoundingClientRect().top
      const line = top + scroller.clientHeight * 0.45
      let current: string | null = null
      for (const el of scroller.querySelectorAll<HTMLElement>('[data-turn-anchor]')) {
        if (el.getBoundingClientRect().top <= line) current = el.dataset.turnAnchor ?? null
        else break
      }
      setActive(current)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [turns.length])

  const go = (key: string) => {
    const scroller = ref.current?.parentElement?.querySelector<HTMLElement>('[data-transcript-scroll]')
    const el = scroller?.querySelector<HTMLElement>(`[data-turn-anchor="${CSS.escape(key)}"]`)
    if (!scroller || !el) return
    const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16
    scroller.scrollTo({ top: offset, behavior: 'smooth' })
  }

  if (ticks.length < 3) return null
  // The tick to mark: the turn in view, or the drawn tick nearest before it when the map samples.
  const order = new Map(turns.map((turn, i) => [turn.key, i]))
  const activeIndex = active !== null ? (order.get(active) ?? -1) : -1
  const markedKey = ticks.reduce<string | null>(
    (best, tick) => ((order.get(tick.key) ?? -1) <= activeIndex ? tick.key : best),
    null
  )

  return (
    <div
      ref={ref}
      data-transcript-map=""
      aria-label={t('map')}
      className="absolute top-1/2 right-[10px] z-[4] hidden -translate-y-1/2 flex-col gap-[7px] px-1 py-2 desktop:flex"
    >
      {ticks.map((tick) => {
        const on = tick.key === markedKey
        return (
          <button
            key={tick.key}
            type="button"
            title={tick.tip}
            aria-label={tick.tip}
            aria-current={on ? 'true' : undefined}
            onClick={() => go(tick.key)}
            className={`h-[3px] cursor-pointer rounded-[2px] border-0 p-0 transition-colors ${
              on
                ? 'w-[22px] bg-(--text-primary)'
                : tick.human
                  ? 'ml-[6px] w-3 bg-(--border-default) hover:bg-(--border-strong)'
                  : 'w-[18px] bg-(--border-strong) hover:bg-(--text-tertiary)'
            }`}
          />
        )
      })}
    </div>
  )
}
