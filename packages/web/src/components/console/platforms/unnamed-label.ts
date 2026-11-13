// No 'use client' here: reached only from the console's client trees, exactly like `registry.ts`.

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'
import type { WebUnnamedSubject } from './contract'
import { platformUnnamedLabel } from './registry'

/** The localized label for a conversation or person its platform never names, or undefined to show what the caller has. */
export type UnnamedLabeler = (platform: string | undefined, subject: WebUnnamedSubject) => string | undefined

/** The console's unnamed-label resolver: a module's readable id as it is, or its noun with a short id tag in the viewer's locale. */
export function useUnnamedLabel(): UnnamedLabeler {
  const t = useTranslations('Platforms.unnamed')
  return useCallback(
    (platform, subject) => {
      const label = platformUnnamedLabel(platform, subject)
      if (!label) return undefined
      return 'text' in label ? label.text : t(label.key, { tag: label.tag })
    },
    [t]
  )
}
