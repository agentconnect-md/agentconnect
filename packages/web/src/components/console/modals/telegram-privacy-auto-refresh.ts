import { useEffect, useRef } from 'react'

export const TELEGRAM_PRIVACY_RECHECK_MS = 5_000

export function useTelegramPrivacyAutoRefresh(active: boolean, refresh: () => Promise<unknown>): void {
  const refreshRef = useRef(refresh)

  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    if (!active) return
    let inFlight = false

    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible' || inFlight) return
      inFlight = true
      void refreshRef
        .current()
        .catch(() => undefined)
        .finally(() => {
          inFlight = false
        })
    }

    const timer = window.setInterval(refreshWhenVisible, TELEGRAM_PRIVACY_RECHECK_MS)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [active])
}
