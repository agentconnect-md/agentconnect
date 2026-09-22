// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel, type Agent } from '@/lib/data'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'

// Confirm-delete an agent. Removing it drops the CP spec and tells the owning daemon
// to tear down its local replica (agent/remove). Lands back on the agents list.
export default function DeleteAgentModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const t = useTranslations('Agents.deleteModal')
  const { orgPath } = useOrgs()
  const { deleteAgent } = useConsoleData()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onDelete = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await deleteAgent(agent.id)
      onClose()
      router.push(orgPath('/agents'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft)">
          <Icon name="trash" size={16} color="var(--status-error)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('title')}</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
          {t('body', { agent: agentLabel(agent) })}
        </p>
        {err && (
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button variant="danger" onClick={onDelete} className={busy ? 'pointer-events-none opacity-50' : undefined}>
          <Icon name="trash" size={15} />
          {busy ? t('deleting') : t('delete')}
        </Button>
      </div>
    </>
  )
}
