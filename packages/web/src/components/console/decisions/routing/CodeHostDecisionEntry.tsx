'use client'

// A watched repository's issues or pull-request row control: its routing Decision's pill, or `+ Decision`.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import { useCodeHostRoutingActions } from '@/lib/decisions/code-host-routing'
import type { CodeHostRoutingDto } from '@/lib/api'
import { CodeHostDecisionModal } from './CodeHostDecisionModal'

export function CodeHostDecisionEntry({
  routing,
  agents,
  onOpenEvaluations
}: {
  /** The scope's routing read; null while the CP cannot serve it. */
  routing: CodeHostRoutingDto | null | undefined
  /** The scope's members as rule targets. */
  agents: RosterAgent[]
  /** Opens the routing's Recent evaluations. */
  onOpenEvaluations?: () => void
}) {
  const t = useTranslations('Decisions.routing.codeHost')
  const tDecisions = useTranslations('Decisions')
  const { myRole } = useOrgs()
  const canWrite = myRole !== 'viewer'
  const decisions = useOptionalDecisionsPrototype()
  const { remove } = useCodeHostRoutingActions()
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  if (!decisions || !routing) return null
  const family = routing.family
  const modal = open && (
    <CodeHostDecisionModal
      routing={routing}
      agents={agents}
      onClose={() => setOpen(false)}
      {...(onOpenEvaluations ? { onOpenEvaluations } : {})}
    />
  )
  const saved = routing.config
  if (saved) {
    const name = decisions.decisions.find((entry) => entry.id === saved.decisionId)?.name ?? t('hidden')
    const status = routing.status && routing.status !== 'enabled' ? routing.status : null
    const stop = async () => {
      setStopping(true)
      setStopError(null)
      try {
        await remove(routing)
      } catch (error) {
        setStopError(t('stopError', { message: error instanceof Error ? error.message : String(error) }))
      } finally {
        setStopping(false)
      }
    }
    return (
      <>
        <span
          className={`inline-flex h-[26px] max-w-full flex-none items-center overflow-hidden rounded-md border bg-(--surface-card) ${
            status ? 'border-(--amber-500)' : 'border-(--border-default)'
          }`}
        >
          <button
            type="button"
            title={
              status
                ? t('pillStatusTitle', { name, status: tDecisions(`binding.status.${status}`) })
                : t('pillTitle', { name, family })
            }
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className="inline-flex h-full min-w-0 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-[7px] hover:bg-(--surface-hover)"
          >
            {status ? (
              <Icon
                name={status === 'access_revoked' ? 'lock' : 'triangle-alert'}
                size={12}
                className="flex-none text-(--amber-500)"
              />
            ) : (
              <Icon name="split" size={12} className="flex-none text-(--brand)" />
            )}
            <span className="mono min-w-0 max-w-[160px] truncate text-[11px] text-(--text-primary)">{name}</span>
          </button>
          {canWrite && (
            <button
              type="button"
              title={stopError ?? t('stop', { family })}
              aria-label={t('stop', { family })}
              disabled={stopping}
              onClick={() => void stop()}
              className={`flex h-full w-[22px] flex-none cursor-pointer items-center justify-center border-0 border-l border-(--border-subtle) bg-transparent hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:cursor-wait ${
                stopError ? 'text-(--status-error)' : 'text-(--text-tertiary)'
              }`}
            >
              <Icon name={stopError ? 'triangle-alert' : 'x'} size={11} />
            </button>
          )}
        </span>
        {modal}
      </>
    )
  }
  if (!canWrite) return null
  return (
    <>
      <button
        type="button"
        title={t('addTitle', { family })}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="inline-flex h-[26px] flex-none cursor-pointer items-center gap-1 rounded-md border border-dashed border-(--border-strong) bg-transparent pl-[6px] pr-2 font-sans text-[11px] font-medium leading-normal text-(--text-secondary) hover:border-solid hover:border-(--brand) hover:bg-(--brand-soft) hover:text-(--brand-soft-text) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-dashed disabled:hover:border-(--border-strong) disabled:hover:bg-transparent disabled:hover:text-(--text-secondary)"
      >
        <Icon name="plus" size={11} />
        {t('add')}
      </button>
      {modal}
    </>
  )
}
