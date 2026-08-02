import { GithubMark, PlatformMark } from '@/components/marks'

type HookKind = 'webhook' | 'github'

interface IntegrationMarkSource {
  id?: string
  platform: string
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
  const visibleIntegrations = integrations.slice(0, 3)
  const visibleHookKinds = distinctHookKinds.slice(0, Math.max(0, 3 - visibleIntegrations.length))

  if (total === 0) return null

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="flex">
        {visibleIntegrations.map((integration, index) => (
          <span
            key={integration.id ?? `${integration.platform}:${index}`}
            className={`imark h-[21px] w-[21px] ${index === 0 ? '' : 'imark-overlap -ml-[7px]'}`}
          >
            <PlatformMark platform={integration.platform} />
          </span>
        ))}
        {visibleHookKinds.map((kind, index) => (
          <span
            key={kind}
            className={`imark h-[21px] w-[21px] ${visibleIntegrations.length + index === 0 ? '' : 'imark-overlap -ml-[7px]'}`}
            title={kind === 'github' ? 'GitHub events' : 'Inbound webhook'}
          >
            {kind === 'github' ? (
              <span className="flex h-[13px] w-[13px] items-center justify-center">
                <GithubMark fillPct={90} />
              </span>
            ) : (
              // The brand-pink webhook mark, not a white glyph on an inverted plate:
              // unplated on dark, that glyph had nothing left to sit on.
              <PlatformMark platform="webhook" />
            )}
          </span>
        ))}
      </span>
      <span className="mono text-[12px] text-(--text-secondary)">+{total}</span>
    </span>
  )
}
