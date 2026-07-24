'use client'

// The caller's OWN Slack App Configuration token, on the Profile page. Per-user
// (docs/designs/slack-install-smoothing.md §Tier B): the app the one-click installer
// creates is owned by whoever's token created it — so you store your own here, and
// only you can generate that app's App-Level token. Stored ⇒ the Add-integration
// modal runs the one-click auto-install for the apps YOU create; absent ⇒ you either
// paste it inline when installing, or fall back to the manual flow.
//
// The token pair is secret — the CP validates it (by rotating) on save, keeps it
// fresh, and never returns it; this card only ever sees status. Org-scoped (keyed by
// the active org), so the fetch waits for OrgProvider to resolve — mirroring the
// org-gated pattern the rest of the console uses.

import { useEffect, useState } from 'react'
import { Button, Icon } from '@/components/ui'
import { fetchSlackConfig, saveSlackConfig, deleteSlackConfig, fmtDate, type SlackConfigDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'

const EMPTY: SlackConfigDto = {
  configured: false,
  funnelEnabled: false,
  autoAvailable: false,
  relayAvailable: false,
  relayPublicUrl: null,
  updatedAt: null
}

export default function SlackConfigCard() {
  // Gate the org-scoped fetch on the active org: on a hard refresh `orgBase()` throws
  // "no active organization" until OrgProvider resolves it, so a bare mount-fetch would
  // catch → show "Not configured" even when it IS. Re-fetch when it resolves.
  const { activeOrg } = useOrgs()
  const [status, setStatus] = useState<SlackConfigDto | 'loading'>('loading')
  const [editing, setEditing] = useState(false)
  const [access, setAccess] = useState('')
  const [refresh, setRefresh] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!activeOrg) return
    let alive = true
    setStatus('loading')
    fetchSlackConfig()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(EMPTY))
    return () => {
      alive = false
    }
  }, [activeOrg])

  const save = async () => {
    if (busy || !access.trim() || !refresh.trim()) return
    setBusy(true)
    setErr(null)
    try {
      setStatus(await saveSlackConfig({ accessToken: access.trim(), refreshToken: refresh.trim() }))
      setEditing(false)
      setAccess('')
      setRefresh('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await deleteSlackConfig()
      setStatus(EMPTY)
      setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const configured = status !== 'loading' && status.configured
  const showForm = status !== 'loading' && (!configured || editing)

  return (
    <div className="card mt-[18px]">
      <div className="cardhead">
        <span className="cardtitle">Slack config token</span>
      </div>

      <div className="px-4 py-[13px]">
        {status === 'loading' ? (
          <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">Loading…</div>
        ) : (
          <>
            {configured && !editing ? (
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon
                    name={status.autoAvailable ? 'circle-check' : 'circle-alert'}
                    size={15}
                    color={status.autoAvailable ? 'var(--brand)' : 'var(--status-paused)'}
                    className="flex-none"
                  />
                  <span className="flex-none font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)">
                    Stored
                  </span>
                  <span className="truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                    {status.autoAvailable
                      ? 'your quick Slack installs are ready'
                      : 'quick install is unavailable on this server'}
                    {status.updatedAt ? ` · updated ${fmtDate(status.updatedAt)}` : ''}
                  </span>
                </div>
                <span className="flex flex-none items-center gap-2">
                  <Button variant="ghost" onClick={() => setEditing(true)}>
                    <Icon name="pencil" size={13} />
                    Replace
                  </Button>
                  <Button variant="ghost" onClick={() => void clear()}>
                    <Icon name="trash-2" size={13} />
                    {busy ? 'Clearing…' : 'Clear'}
                  </Button>
                </span>
              </div>
            ) : (
              !showForm && (
                <div className="font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-tertiary)">
                  Not configured. Store your workspace&rsquo;s App Configuration token to get quick Slack installs for
                  the apps you create.
                </div>
              )
            )}

            {showForm && (
              <div className={configured ? 'mt-1' : ''}>
                <div className="mb-3 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                  The app the installer creates will belong to you, so you can generate its App-Level token yourself.
                  Generate the pair at{' '}
                  <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="lnk">
                    api.slack.com/apps
                  </a>
                  .
                </div>
                <div className="grid grid-cols-1 gap-[10px] min-[440px]:grid-cols-2">
                  <div className="fld">
                    <span className="fldlbl">Access token</span>
                    <input
                      className="inp mn"
                      placeholder="xoxe.xoxp-…"
                      value={access}
                      onChange={(e) => setAccess(e.target.value)}
                    />
                  </div>
                  <div className="fld">
                    <span className="fldlbl">Refresh token</span>
                    <input
                      className="inp mn"
                      placeholder="xoxe-…"
                      value={refresh}
                      onChange={(e) => setRefresh(e.target.value)}
                    />
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    onClick={() => void save()}
                    className={access.trim() && refresh.trim() && !busy ? undefined : 'cursor-default opacity-50'}
                  >
                    <Icon name="check" size={14} />
                    {busy ? 'Saving…' : 'Save'}
                  </Button>
                  {configured && (
                    <Button variant="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            )}

            {err && (
              <div className="mt-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
