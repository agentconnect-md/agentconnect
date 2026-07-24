'use client'

import { useEffect } from 'react'
import { startBrowserOpenTelemetry } from '@/lib/observability'

export function BrowserTelemetry() {
  useEffect(() => {
    startBrowserOpenTelemetry()
  }, [])

  return null
}
