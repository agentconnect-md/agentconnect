'use client'

// A Decision's visible usages, each linked to where the console edits it, plus a count of the ones the viewer cannot see.

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { DecisionUsage } from '@agentconnect.md/protocol/decision-api'

export function DecisionUsageList({
  usages,
  hiddenCount = 0,
  inUse = false,
  hrefFor
}: {
  usages: DecisionUsage[]
  hiddenCount?: number
  /** A server refusal said the Decision is used, so an empty list still names that someone uses it. */
  inUse?: boolean
  hrefFor: (usage: DecisionUsage) => string | null
}) {
  const t = useTranslations('Decisions')
  return (
    <>
      {usages.map((usage) => {
        const href = hrefFor(usage)
        return (
          <div key={`${usage.kind}:${usage.id}`} className="flex flex-wrap items-center gap-[10px] px-4 py-[9px]">
            <Icon name={usage.kind === 'gate' ? 'hash' : 'git-branch'} size={13} color="var(--text-tertiary)" />
            {href ? (
              <Link href={href} className="lnk mono min-w-[120px] flex-1 text-[12.5px]">
                {usage.label}
              </Link>
            ) : (
              <span className="mono min-w-[120px] flex-1 text-[12.5px]">{usage.label}</span>
            )}
            <span className="badge bg-(--surface-active) text-(--text-secondary)">
              {t(`usedBy.kind.${usage.kind}`)}
            </span>
          </div>
        )
      })}
      {hiddenCount > 0 && (
        <div className="px-4 py-[9px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {t('usedBy.hidden', { count: hiddenCount })}
        </div>
      )}
      {inUse && usages.length === 0 && hiddenCount === 0 && (
        <div className="px-4 py-[9px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {t('usedBy.hiddenUnknown')}
        </div>
      )}
    </>
  )
}
