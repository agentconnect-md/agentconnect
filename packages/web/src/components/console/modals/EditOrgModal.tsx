// No 'use client' here: rendered only by ModalProvider (the client boundary).

// Edit-organization dialog (design: `isEditWorkspaceModal`). REAL: PATCH
// /orgs/:id (owner-only server-side; the Settings page only offers the button
// to owners). Edits the ACTIVE org's URL name (slug) + display name, and hosts
// the delete-organization danger zone (two-click confirm; the CP refuses while
// the org still has daemons, and everything else cascades).

import { useState } from 'react'
import { Button, Icon } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { useOrgs, orgColor, orgUrlPrefix } from '@/lib/org-context'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

export default function EditOrgModal({ onClose }: { onClose: () => void }) {
  const { activeOrg, renameOrg, deleteOrg } = useOrgs()
  const [slug, setSlug] = useState(activeOrg?.slug ?? '')
  const [name, setName] = useState(activeOrg?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (!activeOrg) return null
  const valid = SLUG_RE.test(slug)
  const nextName = name.trim() // '' clears the display name → server falls back to the slug

  const submit = async () => {
    if (!valid || busy) return
    if (slug === activeOrg.slug && (nextName || null) === (activeOrg.name ?? null)) return onClose()
    setBusy(true)
    setErr(null)
    try {
      await renameOrg(activeOrg.id, { name: nextName, slug })
      onClose()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setErr('That URL name is already taken.')
      else setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy) return
    if (!deleteArmed) return setDeleteArmed(true) // first click arms
    setBusy(true)
    setErr(null)
    try {
      await deleteOrg(activeOrg.id)
      onClose() // the org context moves the console to a remaining org
    } catch (e) {
      if (e instanceof ApiError && e.status === 409)
        setErr('The organization still has daemons — remove them on the Daemons page first.')
      else setErr(e instanceof Error ? e.message : String(e))
      setDeleteArmed(false)
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span
          className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] font-sans text-[13px] font-semibold leading-normal text-white"
          style={{ background: orgColor(activeOrg.id) }}
        >
          {(activeOrg.name ?? activeOrg.slug).charAt(0).toUpperCase()}
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Edit organization</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="fld">
          <span className="fldlbl">Name</span>
          <div className="inp justify-start gap-0">
            <span className="flex-none font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              {orgUrlPrefix()}
            </span>
            <input
              className="mono min-w-0 flex-1 border-0 bg-transparent font-sans text-[12.5px] normal-nums outline-0"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
          </div>
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            Lowercase letters and hyphens — appears in the URL.
          </span>
        </div>
        <div className="fld mt-[14px]">
          <span className="fldlbl">Display name (optional)</span>
          <div className="inp">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={activeOrg.slug}
              className="min-w-0 flex-1 border-0 bg-transparent outline-0 [font:inherit]"
            />
          </div>
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            Anything you like — shown across the console. Leave blank to use the URL name.
          </span>
        </div>
        <div className="mt-[14px] flex items-start gap-2 rounded-md bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="info" size={14} className="mt-[1px] flex-none" />
          <span>Only owners can edit these. Changing the name updates the organization URL for everyone.</span>
        </div>
        <div className="mt-[18px] flex items-center gap-[11px] rounded-[9px] border border-[rgba(220,75,75,.28)] bg-(--status-error-soft) px-[13px] py-3">
          <Icon name="trash-2" size={16} color="var(--status-error)" className="flex-none" />
          <div className="flex-1">
            <div className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
              Delete organization
            </div>
            <div className="font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
              Deletes its agents, schedules, integrations and members for good. Daemons must be removed first.
            </div>
          </div>
          <button
            onClick={() => void remove()}
            className={`flex-none cursor-pointer rounded-[7px] border border-[rgba(220,75,75,.4)] px-[11px] py-[6px] font-sans text-[12px] font-semibold leading-normal ${
              deleteArmed ? 'bg-(--status-error) text-white' : 'bg-(--surface-card) text-(--status-error)'
            }`}
          >
            {deleteArmed ? 'Confirm delete' : 'Delete'}
          </button>
        </div>
        {err && (
          <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit()}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </>
  )
}
