'use client'

import { NextIntlClientProvider, useLocale } from 'next-intl'
import { useSyncExternalStore, type ReactNode } from 'react'

const subscribe = () => () => {}
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
// Undefined inherits the server's zone from the parent provider, so hydration matches the server HTML.
const serverTimeZone = () => undefined

// Hydrates with the server's time zone, then re-renders formatted dates in the viewer's own.
export function BrowserTimeZoneProvider({ children }: { children: ReactNode }) {
  const timeZone = useSyncExternalStore(subscribe, browserTimeZone, serverTimeZone)
  return (
    <NextIntlClientProvider locale={useLocale()} timeZone={timeZone}>
      {children}
    </NextIntlClientProvider>
  )
}
