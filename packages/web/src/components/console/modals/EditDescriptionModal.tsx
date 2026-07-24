// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useEffect, useRef, useState } from 'react'
import type { Agent } from '@/lib/data'
import { fetchAgentDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

// The Description card's dedicated editor (design: isEditDescModal) — description
// left the Edit-agent form when it became its own card on the config tab.
export default function EditDescriptionModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { updateAgent } = useConsoleData()
  const [loaded, setLoaded] = useState(false)
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fetched = useRef(false)

  // Prefill from the raw spec (GET /agents/:id) — the UI `Agent` carries a '—'
  // placeholder for a missing description, never the raw value.
  useEffect(() => {
    if (fetched.current) return
    fetched.current = true
    fetchAgentDto(agent.id).then(
      (dto) => {
        setDescription(dto.description ?? '')
        setLoaded(true)
      },
      (e) => {
        setErr(e instanceof Error ? e.message : String(e))
        setLoaded(true)
      }
    )
  }, [agent.id])

  const save = async () => {
    if (saving || !loaded) return
    setSaving(true)
    setErr(null)
    try {
      await updateAgent(agent.id, { description: description.trim() ? description.trim() : null })
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="pencil" size={15} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Edit description</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        {!loaded ? (
          <div className="flex justify-center py-8">
            <Spinner size={28} />
          </div>
        ) : (
          <div className="fld">
            <span className="fldlbl">Description</span>
            <textarea
              className="inp resize-y px-3 py-[10px] leading-[1.6] focus:border-(--brand) focus:outline-none"
              rows={6}
              placeholder="What does this agent do?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              autoFocus
            />
          </div>
        )}
        {err && (
          <div className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
            <Icon name="triangle-alert" size={15} />
            {err}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void save()} className={!saving && loaded ? undefined : 'cursor-default opacity-50'}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  )
}
