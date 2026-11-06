'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { DaemonRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useAgo } from '@/lib/computers'
import { autoUpgradeNotes, type AutoUpgradeNote } from '@/lib/daemon-auto-upgrade'
import { vTag } from '@/components/console/DaemonLifecycleBadge'
import { Icon, Toggle } from '@/components/ui'

const NOTE_ICON: Record<AutoUpgradeNote['kind'], string> = {
  upgrading: 'circle-fading-arrow-up',
  upgraded: 'circle-check',
  failed: 'triangle-alert',
  waiting: 'clock'
}
const NOTE_COLOR: Record<AutoUpgradeNote['kind'], string> = {
  upgrading: 'var(--brand)',
  upgraded: 'var(--text-tertiary)',
  failed: 'var(--status-error)',
  waiting: 'var(--text-tertiary)'
}

// The header's Auto-upgrade switch beside the version, applied on change; help and status notes ride its tooltip.
export function DaemonAutoUpgradeSetting({ daemon }: { daemon: DaemonRow }) {
  const t = useTranslations('Daemons.detail.autoUpgrade')
  const { setDaemonAutoUpgrade } = useConsoleData()
  const ago = useAgo()
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const busy = optimistic !== null
  const checked = optimistic ?? daemon.autoUpgrade
  const supported = daemon.autoUpgradeSupported
  const locked = !supported || !daemon.canManageLifecycle

  const change = async (next: boolean) => {
    if (busy || locked) return
    setOptimistic(next)
    setErr(null)
    try {
      await setDaemonAutoUpgrade(daemon.daemonId, next)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setOptimistic(null)
    }
  }

  const named = (version: string | null) => (version ? vTag(version) : t('newRelease'))
  const noteText = (note: AutoUpgradeNote): string => {
    switch (note.kind) {
      case 'upgrading':
        return t('upgrading', { version: named(note.version) })
      case 'upgraded':
        return note.settledAt
          ? t('upgradedAgo', { version: named(note.version), ago: ago(note.settledAt) })
          : t('upgraded', { version: named(note.version) })
      case 'failed':
        return note.outcome
          ? t('failed', { version: named(note.version), outcome: note.outcome })
          : t('failedNoReason', { version: named(note.version) })
      case 'waiting':
        return t('waiting', { version: vTag(note.version) })
    }
  }
  const notes = autoUpgradeNotes(daemon)
  const tooltip = [supported ? t('help') : t('unsupported'), ...notes.map(noteText)].join('\n')

  return (
    <span className="inline-flex items-center gap-[6px] whitespace-nowrap" title={tooltip}>
      <span className={locked ? 'inline-flex opacity-55' : 'inline-flex'}>
        <Toggle
          size="sm"
          checked={checked}
          disabled={locked || busy}
          onChange={(next) => void change(next)}
          ariaLabel={t('label')}
        />
      </span>
      <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">{t('label')}</span>
      {notes.map((note) => (
        <span key={note.kind} className="inline-flex">
          <Icon name={NOTE_ICON[note.kind]} size={13} color={NOTE_COLOR[note.kind]} />
          <span className="sr-only">{noteText(note)}</span>
        </span>
      ))}
      {err && <span className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</span>}
    </span>
  )
}
