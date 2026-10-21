// No 'use client' here: rendered only by AddComputerModal (inside ModalProvider, the client boundary).

// A `manual` computer from the deployment's pool (computer-use.md §10, §15.1): a name and which agents may share it.
import { useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ComputerAgentAccess } from '@agentconnect.md/protocol/computer'
import { createPoolComputer } from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { ChoicePills } from '@/components/console/VisibilityField'
import { AgentIconView } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

type Mode = ComputerAgentAccess['mode']

export default function AddPoolComputer({
  onClose,
  available,
  sourcePicker
}: {
  onClose: () => void
  available: boolean
  sourcePicker: ReactNode
}) {
  const t = useTranslations('Computers.add')
  const ta = useTranslations('Computers.agentAccess')
  const router = useRouter()
  const { orgPath } = useOrgs()
  const { agents, refresh } = useConsoleData()
  const [name, setName] = useState('')
  const [mode, setMode] = useState<Mode>('selected')
  const [picked, setPicked] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const trimmed = name.trim()
  const ready = available && trimmed.length > 0 && !(mode === 'selected' && picked.length === 0)

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((v) => v !== id) : [...p, id]))

  const create = async () => {
    if (creating || !ready) return
    setCreating(true)
    setErr(null)
    try {
      const created = await createPoolComputer({
        name: trimmed,
        agentAccess: { mode, agents: mode === 'selected' ? picked : [] }
      })
      // The agents' derived Computers lists now include it.
      refresh()
      onClose()
      router.push(orgPath(`/computers/${created.id}`))
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="monitor" size={17} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('title')}</span>
      </div>
      <div className="modalbody">
        {sourcePicker}
        <p className="mb-[14px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
          {t('poolDescription')}
        </p>
        <div className="fld">
          <span className="fldlbl">{t('poolName')}</span>
          <input
            className="inp"
            value={name}
            maxLength={120}
            spellCheck={false}
            placeholder={t('poolNamePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="fld mt-[14px]">
          <span className="fldlbl">{t('poolAccess')}</span>
          <ChoicePills
            value={mode}
            onPick={setMode}
            disabled={creating}
            options={[
              { value: 'none', title: ta('none') },
              { value: 'selected', title: ta('selected') },
              { value: 'all', title: ta('all') }
            ]}
          />
          <span className="mt-[6px] block font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            {t('poolAccessHint')}
          </span>
        </div>
        {mode === 'selected' && (
          <div
            role="group"
            aria-label={ta('selectedTitle')}
            className="mt-[10px] max-h-[220px] overflow-y-auto rounded-md border border-(--border-subtle)"
          >
            {agents.length === 0 ? (
              <div className="px-3 py-[10px] font-sans text-[12.5px] text-(--text-tertiary)">{ta('noMoreAgents')}</div>
            ) : (
              agents.map((a) => (
                <label
                  key={a.id}
                  className="flex cursor-pointer items-center gap-[10px] border-b border-(--border-subtle) px-3 py-[9px] last:border-b-0 max-desktop:min-h-11"
                >
                  <input
                    type="checkbox"
                    checked={picked.includes(a.id)}
                    disabled={creating}
                    onChange={() => toggle(a.id)}
                    data-pool-agent={a.id}
                  />
                  <span className="flex h-6 w-6 flex-none overflow-hidden rounded-sm">
                    <AgentIconView icon={a.icon} runtime={a.runtime} size={24} />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-medium leading-normal">
                    {agentLabel(a)}
                  </span>
                </label>
              ))
            )}
          </div>
        )}
        {!available && (
          <div
            role="status"
            className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-[#9a6500]"
          >
            <Icon name="triangle-alert" size={15} className="mt-[1px] flex-none" />
            {t('poolUnavailable')}
          </div>
        )}
        {err && (
          <div
            role="alert"
            className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)"
          >
            <Icon name="triangle-alert" size={15} />
            {t('poolError', { message: err })}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button variant="primary" disabled={!ready || creating} onClick={() => void create()}>
          {creating ? t('poolCreating') : t('poolCreate')}
        </Button>
      </div>
    </>
  )
}
