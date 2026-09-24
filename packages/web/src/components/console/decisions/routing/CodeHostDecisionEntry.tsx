'use client'

// A watched repository's issues or change-request row control: its routing Decision's chip, empty or bound.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useOrgs } from '@/lib/org-context'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import { codeHostRoutingSubject, useCodeHostRoutingActions } from '@/lib/decisions/code-host-routing'
import type { CodeHostRoutingDto } from '@/lib/api'
import { DecisionChip } from '../DecisionChip'
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
  const subject = codeHostRoutingSubject(routing)
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
    const title = status
      ? t('pillStatusTitle', { name, status: tDecisions(`binding.status.${status}`) })
      : t('pillTitle', { name, subject })
    return (
      <>
        <DecisionChip
          name={name}
          title={title}
          onOpen={() => setOpen(true)}
          warning={status ? (status === 'access_revoked' ? 'lock' : 'triangle-alert') : undefined}
          remove={
            canWrite
              ? {
                  label: t('stop', { subject }),
                  title: stopError ?? t('stop', { subject }),
                  onClick: () => void stop(),
                  busy: stopping,
                  failed: stopError !== null
                }
              : undefined
          }
        />
        {modal}
      </>
    )
  }
  if (!canWrite) return null
  return (
    <>
      <DecisionChip name={null} label={t('add')} title={t('addTitle', { subject })} onOpen={() => setOpen(true)} />
      {modal}
    </>
  )
}
