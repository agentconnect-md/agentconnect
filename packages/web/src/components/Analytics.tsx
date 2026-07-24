'use client'

import { useEffect } from 'react'
import { initAnalytics } from '@/lib/analytics'

// Boot posthog-js once on the client. No-op when POSTHOG_API_KEY is unset.
export function Analytics() {
  useEffect(() => {
    void initAnalytics()
  }, [])

  return null
}
