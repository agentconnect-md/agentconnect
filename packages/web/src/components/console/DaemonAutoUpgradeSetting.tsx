'use client'

import { useEffect, useState, type MouseEvent } from 'react'
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
const NOTE_TEXT: Record<AutoUpgradeNote['kind'], string> = {
  upgrading: 'text-(--brand)',
  upgraded: 'text-(--text-secondary)',
  failed: 'text-(--status-error)',
  waiting: 'text-(--text-tertiary)'
}

// The header's Auto-upgrade switch beside the version, applied on change; its label opens the help and status notes.
export function DaemonAutoUpgradeSetting({ daemon }: { daemon: DaemonRow }) {
  const t = useTranslations('Daemons.detail.autoUpgrade')
  const { setDaemonAutoUpgrade } = useConsoleData()
  const ago = useAgo()
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Viewport position of the open details panel; null while closed.
  const [panel, setPanel] = useState<{ top: number; left: number; width: number } | null>(null)

  useEffect(() => {
    if (!panel) return
    const close = () => setPanel(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [panel])

  // Clamped to the viewport with a 16px gutter, wherever the wrapping header put the label.
  const toggleDetails = (e: MouseEvent<HTMLButtonElement>) => {
    if (panel) return setPanel(null)
    const r = e.currentTarget.getBoundingClientRect()
    const width = Math.min(280, window.innerWidth - 32)
    const left = Math.max(16, Math.min(r.left, window.innerWidth - 16 - width))
    setPanel({ top: r.bottom + 6, left, width })
  }

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
  const help = supported ? t('help') : t('unsupported')

  return (
    <span className="inline-flex items-center gap-[6px] whitespace-nowrap">
      <span className={locked ? 'inline-flex opacity-55' : 'inline-flex'}>
        <Toggle
          size="sm"
          checked={checked}
          disabled={locked || busy}
          onChange={(next) => void change(next)}
          ariaLabel={t('label')}
        />
      </span>
      {/* A tap target, not only a hover title: touch screens must reach the reason and the last outcome too. */}
      <button
        type="button"
        aria-expanded={panel !== null}
        onClick={toggleDetails}
        title={[help, ...notes.map(noteText)].join('\n')}
        className="inline-flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)"
      >
        {t('label')}
        {notes.map((note) => (
          <Icon key={note.kind} name={NOTE_ICON[note.kind]} size={13} color={NOTE_COLOR[note.kind]} />
        ))}
      </button>
      {err && <span className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</span>}
      {panel && (
        <>
          <div onClick={() => setPanel(null)} className="fixed inset-0 z-45" />
          <div
            role="note"
            style={panel}
            className="fixed z-50 flex flex-col gap-[6px] whitespace-normal rounded-[8px] border border-(--border-default) bg-(--surface-card) p-3 shadow-(--shadow-lg)"
          >
            <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">{help}</span>
            {notes.map((note) => (
              <span
                key={note.kind}
                className={`flex items-start gap-[6px] font-sans text-[12px] font-medium leading-[1.5] ${NOTE_TEXT[note.kind]}`}
              >
                <Icon name={NOTE_ICON[note.kind]} size={13} className="mt-[2px] flex-none" />
                <span className="min-w-0 break-words">{noteText(note)}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </span>
  )
}
