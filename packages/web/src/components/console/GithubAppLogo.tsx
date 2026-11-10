'use client'

import { useState } from 'react'
import { GithubMark } from '@/components/marks'
import { SQUARE_MARK_FILL_PCT } from '@/components/mark-box'
import { githubAppLogoUrl } from '@/lib/api'

// Show the App logo, falling back to the GitHub mark when unavailable.
export function GithubAppLogo({ appId, size = 28 }: { appId?: number | null; size?: number }) {
  const [broken, setBroken] = useState<number | null>(null)
  const tile =
    'flex flex-none items-center justify-center overflow-hidden rounded-[7px] border border-(--border-default) bg-(--surface-card)'
  return (
    <span
      className={tile}
      style={{ width: size, height: size }}
      data-github-app-logo={broken !== appId ? appId : undefined}
    >
      {appId != null && broken !== appId ? (
        <img
          alt=""
          src={githubAppLogoUrl(appId, size)}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setBroken(appId)}
        />
      ) : (
        <span className="flex h-[14px] w-[14px] items-center justify-center">
          <GithubMark color="var(--text-primary)" fillPct={SQUARE_MARK_FILL_PCT} />
        </span>
      )}
    </span>
  )
}
