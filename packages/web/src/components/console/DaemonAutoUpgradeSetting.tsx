'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { DaemonRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useAgo } from '@/lib/computers'
import { autoUpgradeNotes, type AutoUpgradeNote } from '@/lib/daemon-auto-upgrade'
import { vTag } from '@/components/console/DaemonLifecycleBadge'
import { Icon, Toggle } from '@/components/ui'

// The daemon detail's Auto-upgrade switch, applied on change; `mobile` swaps the row chrome for the System card's.
export function DaemonAutoUpgradeSetting({ daemon, mobile = false }: { daemon: DaemonRow; mobile?: boolean }) {
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
  const noteIcon: Record<AutoUpgradeNote['kind'], string> = {
    upgrading: 'circle-fading-arrow-up',
    upgraded: 'circle-check',
    failed: 'triangle-alert',
    waiting: 'clock'
  }
  const noteColor: Record<AutoUpgradeNote['kind'], string> = {
    upgrading: 'text-(--brand)',
    upgraded: 'text-(--text-secondary)',
    failed: 'text-(--status-error)',
    waiting: 'text-(--text-tertiary)'
  }

  return (
    <div
      className={
        mobile
          ? 'grid grid-cols-[1fr_auto] items-start gap-4 border-t border-(--border-subtle) px-4 py-3'
          : 'row grid-cols-[1fr_auto] items-start gap-3'
      }
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span
          className={
            mobile
              ? 'font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)'
              : 'font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)'
          }
        >
          {t('label')}
        </span>
        <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {supported ? t('help') : t('unsupported')}
        </span>
        {autoUpgradeNotes(daemon).map((note) => (
          <span
            key={note.kind}
            className={`flex items-start gap-[6px] font-sans text-[12px] font-medium leading-[1.5] ${noteColor[note.kind]}`}
          >
            <Icon name={noteIcon[note.kind]} size={13} className="mt-[2px] flex-none" />
            <span className="min-w-0 break-words">{noteText(note)}</span>
          </span>
        ))}
        {err && <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</span>}
      </div>
      <span className={locked ? 'opacity-55' : undefined}>
        <Toggle
          checked={checked}
          disabled={locked || busy}
          onChange={(next) => void change(next)}
          ariaLabel={t('label')}
        />
      </span>
    </div>
  )
}
