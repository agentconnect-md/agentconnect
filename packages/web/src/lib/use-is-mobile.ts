'use client'

import { useEffect, useState } from 'react'

// SSR-safe mobile-viewport check. Returns `false` on the server and the first client
// paint — matching the desktop-first markup so hydration never mismatches — then
// flips to the real value after mount and stays in sync via matchMedia. The 768px
// breakpoint mirrors the `@media (max-width: 768px)` layer in globals.css, so JS and
// CSS agree on where "mobile" begins.
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const sync = () => setIsMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [breakpoint])
  return isMobile
}
