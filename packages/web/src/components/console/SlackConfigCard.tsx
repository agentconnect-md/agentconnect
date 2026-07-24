'use client'

// The caller's OWN Slack App Configuration token, on the Profile page. Per-user
// (docs/designs/slack-install-smoothing.md §Tier B): the app the one-click installer
// creates is owned by whoever's token created it — so you store your own here, and
// only you can generate that app's App-Level token. Stored ⇒ the Add-integration
// modal runs the one-click auto-install for the apps YOU create; absent ⇒ you either
// paste it inline when installing, or fall back to the manual flow.
//
// The config (access) token is required; the refresh token is optional — with it the
// pair auto-rotates and never expires (durable), without it the access token is stored
// as-is and lapses after ~12h (then re-enter). The tokens are secret — the CP validates
// + normalizes on save and never returns them; this card only ever sees status.
// Org-scoped (keyed by the active org), so the fetch waits for OrgProvider to resolve —
// mirroring the org-gated pattern the rest of the console uses.

import { useEffect, useState } from 'react'
import { Button, Icon } from '@/components/ui'
import { fetchSlackConfig, saveSlackConfig, deleteSlackConfig, fmtDate, type SlackConfigDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'

const EMPTY: SlackConfigDto = {
  configured: false,
  durable: false,
  funnelEnabled: false,
  autoAvailable: false,
  accessExpiresAt: null,
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
    // The access (config) token is required; the refresh token is optional — omit it and
    // the CP stores an access-only token that works until it expires (~12h), then re-enter.
    if (busy || !access.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const refreshTrim = refresh.trim()
      setStatus(
        await saveSlackConfig({
          accessToken: access.trim(),
          ...(refreshTrim ? { refreshToken: refreshTrim } : {})
        })
      )
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
  // An access-only token (no refresh) that has passed its ~12h expiry — the caller must
  // re-enter it. Durable tokens auto-rotate and never reach this state.
  const accessExpired =
    status !== 'loading' &&
    status.configured &&
    !status.durable &&
    (status.accessExpiresAt == null || new Date(status.accessExpiresAt).getTime() <= Date.now())

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
                    name={status.durable && status.autoAvailable ? 'circle-check' : 'circle-alert'}
                    size={15}
                    color={
                      accessExpired
                        ? 'var(--status-error)'
                        : status.durable && status.autoAvailable
                          ? 'var(--brand)'
                          : 'var(--status-paused)'
                    }
                    className="flex-none"
                  />
                  <span className="flex-none font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)">
                    {accessExpired ? 'Expired' : 'Stored'}
                  </span>
                  <span className="truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                    {!status.funnelEnabled
                      ? 'quick install is unavailable on this server'
                      : accessExpired
                        ? 're-enter your config token to run quick installs again'
                        : status.durable
                          ? `auto-renews — quick Slack installs stay ready${status.updatedAt ? ` · updated ${fmtDate(status.updatedAt)}` : ''}`
                          : `expires ${status.accessExpiresAt ? fmtDate(status.accessExpiresAt) : 'soon'} — add a refresh token so it never expires`}
                  </span>
                </div>
                <span className="flex flex-none items-center gap-2">
                  <Button variant="ghost" onClick={() => setEditing(true)}>
                    <Icon name="pencil" size={13} />
                    {accessExpired ? 'Re-enter' : 'Replace'}
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
                <div className="mb-3 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-tertiary)">
                  Store your Slack App Configuration token to get one-click installs for the apps you create. The{' '}
                  <span className="font-medium text-(--text-secondary)">config token alone is enough</span> — it works
                  for about 12 hours. Add the refresh token too and it auto-renews, so it never expires. Generate them
                  at{' '}
                  <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="lnk">
                    api.slack.com/apps
                  </a>{' '}
                  → Your App Configuration Tokens.
                </div>
                <div className="grid grid-cols-1 gap-[10px] min-[440px]:grid-cols-2">
                  <div className="fld">
                    <span className="fldlbl">Config token</span>
                    <input
                      className="inp mn"
                      placeholder="xoxe.xoxp-…"
                      value={access}
                      onChange={(e) => setAccess(e.target.value)}
                    />
                  </div>
                  <div className="fld">
                    <span className="fldlbl">
                      Refresh token <span className="font-normal text-(--text-tertiary)">(optional)</span>
                    </span>
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
                    className={access.trim() && !busy ? undefined : 'cursor-default opacity-50'}
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
