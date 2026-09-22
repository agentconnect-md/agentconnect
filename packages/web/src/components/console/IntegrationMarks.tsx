import type { ReactNode } from 'react'
import { GiteaMark, GithubMark, GitlabMark, PlatformMark } from '@/components/marks'
import type { HookKind } from '@/lib/api'

// Total over the hook-kind vocabulary, so a new code host is given its own mark here
// instead of inheriting the generic webhook glyph. The webhook mark is the brand-pink
// plate rather than a white glyph, which had nothing to sit on when unplated on dark.
const HOOK_KIND_MARK: Record<HookKind, ReactNode> = {
  github: (
    <span className="flex h-[13px] w-[13px] items-center justify-center">
      <GithubMark fillPct={90} />
    </span>
  ),
  gitlab: (
    <span className="flex h-[13px] w-[13px] items-center justify-center">
      <GitlabMark fillPct={90} />
    </span>
  ),
  gitea: (
    <span className="flex h-[13px] w-[13px] items-center justify-center">
      <GiteaMark fillPct={90} />
    </span>
  ),
  webhook: <PlatformMark platform="webhook" />
}

interface IntegrationMarkSource {
  id?: string
  platform: string
  revoked: boolean
}

/** The corner dot on a revoked integration's mark — one shape for every platform and surface. */
export function RevokedMarkDot() {
  return (
    <span
      aria-hidden
      data-revoked-dot
      className="absolute -bottom-[2px] -right-[2px] z-[1] h-2 w-2 rounded-full border-[1.5px] border-(--surface-card) bg-(--status-error)"
    />
  )
}

export function IntegrationMarks({
  integrations,
  hookKinds
}: {
  integrations: readonly IntegrationMarkSource[]
  hookKinds: readonly HookKind[]
}) {
  const distinctHookKinds = [...new Set(hookKinds)]
  const total = integrations.length + distinctHookKinds.length
  // Revoked marks lead, so the three-mark cap never hides the one that needs attention.
  const visibleIntegrations = [
    ...integrations.filter((i) => i.revoked),
    ...integrations.filter((i) => !i.revoked)
  ].slice(0, 3)
  const visibleHookKinds = distinctHookKinds.slice(0, Math.max(0, 3 - visibleIntegrations.length))

  if (total === 0) return null

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {/* `isolate` keeps the revoked dot's lift above the next overlapping mark inside this cluster. */}
      <span className="isolate flex">
        {visibleIntegrations.map((integration, index) => (
          <span
            key={integration.id ?? `${integration.platform}:${index}`}
            className={`imark relative h-[21px] w-[21px] ${index === 0 ? '' : 'imark-overlap -ml-[7px]'}`}
          >
            <PlatformMark platform={integration.platform} />
            {integration.revoked && <RevokedMarkDot />}
          </span>
        ))}
        {/* No hover title: these sit beside platform marks, which carry none either. */}
        {visibleHookKinds.map((kind, index) => (
          <span
            key={kind}
            className={`imark h-[21px] w-[21px] ${visibleIntegrations.length + index === 0 ? '' : 'imark-overlap -ml-[7px]'}`}
          >
            {HOOK_KIND_MARK[kind]}
          </span>
        ))}
      </span>
      <span className="mono text-[12px] text-(--text-secondary)">+{total}</span>
    </span>
  )
}
