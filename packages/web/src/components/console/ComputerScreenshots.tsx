'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Spinner } from '@/components/marks'
import { fetchComputerScreenshot, type ComputerScreenshotDto } from '@/lib/api'

/** Waits between reads of a screenshot that may still be uploading; then it is reported unavailable. */
export const PENDING_RETRY_MS = [2000, 5000, 10_000, 20_000]

type Loaded = { state: 'loading' } | { state: 'ready'; shot: ComputerScreenshotDto } | { state: 'unavailable' }

// One stored screenshot: resolved through the Control Plane, which signs a short-lived read only for an authorized viewer.
function StoredScreenshot({ sessionId, sha256 }: { sessionId: string; sha256: string }) {
  const t = useTranslations('Sessions.detail')
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoaded({ state: 'loading' })
    // The reference reaches the timeline before its background upload is confirmed, so a miss is retried a few times.
    const attempt = (n: number) =>
      fetchComputerScreenshot(sessionId, sha256).then(
        (shot) => live && setLoaded({ state: 'ready', shot }),
        () => {
          if (!live) return
          const delay = PENDING_RETRY_MS[n]
          if (delay === undefined) setLoaded({ state: 'unavailable' })
          else timer = setTimeout(() => void attempt(n + 1), delay)
        }
      )
    void attempt(0)
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, sha256])

  if (loaded.state === 'loading') return <Spinner size={13} />
  if (loaded.state === 'unavailable') {
    return (
      <div className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
        {t('screenshotUnavailable')}
      </div>
    )
  }
  const { shot } = loaded
  return (
    <a href={shot.url} target="_blank" rel="noreferrer noopener" className="block max-w-full">
      <img
        src={shot.url}
        alt={t('screenshotAlt', { takenAt: new Date(shot.takenAt).toLocaleString() })}
        className="max-h-80 max-w-full rounded-sm border border-(--border-subtle)"
        loading="lazy"
      />
    </a>
  )
}

/** The screenshots a computer tool result stored, by the `sha256:` references it carries. */
export function ComputerScreenshots({ sessionId, refs }: { sessionId: string; refs: string[] }) {
  if (refs.length === 0) return null
  return (
    <div className="mt-[6px] flex flex-col gap-2">
      {refs.map((sha256) => (
        <StoredScreenshot key={sha256} sessionId={sessionId} sha256={sha256} />
      ))}
    </div>
  )
}
