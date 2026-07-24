// No 'use client' here: rendered only by ModalProvider (the client boundary).

// Create-organization dialog (design: `isCreateOrgModal`). REAL: POST /orgs —
// the caller becomes the org's first owner and the console switches into it.

import { useState } from 'react'
import { Button, Icon } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { useOrgs, orgUrlPrefix } from '@/lib/org-context'

/** Lowercase letters/digits/hyphens — mirrors the CP's OrgSlug shape. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

export default function CreateOrgModal({ onClose }: { onClose: () => void }) {
  const { createOrg } = useOrgs()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const valid = SLUG_RE.test(slug)

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setErr(null)
    try {
      await createOrg({ name: name.trim() || undefined, slug })
      onClose()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setErr('That URL name is already taken.')
      else setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="building-2" size={17} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Create organization</span>
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
              className="mono min-w-0 flex-1 border-0 bg-transparent text-[12.5px] normal-nums outline-0 [font-family:inherit]"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="my-organization"
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
              placeholder="My Organization"
              className="min-w-0 flex-1 border-0 bg-transparent outline-0 [font:inherit]"
            />
          </div>
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            Anything you like — shown across the console. Defaults to the URL name.
          </span>
        </div>
        <div className="mt-[14px] flex items-start gap-2 rounded-md bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="info" size={14} className="mt-[1px] flex-none" />
          <span>
            You&apos;ll be the organization&apos;s owner. Daemons, agents and members are per-organization — invite your
            team after creating it.
          </span>
        </div>
        {err && (
          <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
            Could not create — {err}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit()}>
          <Icon name="building-2" size={14} />
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </>
  )
}
