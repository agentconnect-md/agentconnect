'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ensureClusterExecution } from '@/lib/api'
import { presentedDaemonStatus, status, type DaemonRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useModal } from '@/components/console/ModalProvider'
import { RestrictedLock } from '@/components/console/VisibilityField'
import { DaemonUpgradeBadge } from '@/components/console/DaemonUpgradeBadge'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'

/**
 * Orgs whose envelope this tab already checked, so opening Daemons repeatedly
 * costs one request per organization, not one per navigation. Module-level
 * rather than state: the view unmounts on every route change.
 */
const ensuredOrgs = new Set<string>()

/**
 * Where the deployment runs managed execution, this page is the convergence
 * point for an org that has no AgentConnectOrg yet — one created before this
 * deployment, or outside `POST /orgs` (a JIT personal org, a waitlist redeem).
 * The endpoint is idempotent and never re-enables an org whose owner switched
 * cluster execution off, so the visit is safe to repeat.
 *
 * Failure is silent by design: a deployment with no cluster 404s the whole
 * surface, a non-owner is refused, and neither is news to someone who came here
 * to look at daemons. The daemon list is refreshed only when the check ran,
 * because provisioning the credential is what registers the envelope's daemon.
 */
function useEnsureClusterEnvelope(orgId: string | undefined, isOwner: boolean, refreshDaemons: () => Promise<void>) {
  useEffect(() => {
    if (!orgId || !isOwner || ensuredOrgs.has(orgId)) return
    ensuredOrgs.add(orgId)
    void ensureClusterExecution(orgId)
      .then(() => refreshDaemons())
      .catch(() => {})
  }, [orgId, isOwner, refreshDaemons])
}

export default function DaemonsView() {
  const { daemons, daemonsLoading, agents, refreshDaemons } = useConsoleData()
  const { openModal } = useModal()
  const { activeOrg, myRole } = useOrgs()
  useEnsureClusterEnvelope(activeOrg?.id, myRole === 'owner', refreshDaemons)

  // Hosted-agent count per daemon — agents assigned to it (mirrors the detail
  // view's "Agents hosted"). NOT daemon.agents, which is the active-session count.
  const hostedByDaemon = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of agents) map.set(a.daemon, (map.get(a.daemon) ?? 0) + 1)
    return map
  }, [agents])

  // Fleet summary for the mobile-only strip below.
  const online = daemons.filter((d) => d.status === 'online').length
  const paused = daemons.length - online

  return (
    <div className="wrap px-4 pt-[14px] pb-1 desktop:p-0">
      {/* Desktop-only header row — on mobile the Shell app bar supplies the
          title, search and "+", so nothing renders here below 769px. */}
      <div className="mb-4 hidden min-h-[34px] items-center gap-4 desktop:flex">
        <div className="flex-1">
          <p className="psub mt-0">
            Your AgentConnect daemons. Each hosts agents over ACP and holds platform connections.
          </p>
        </div>
        <Button size="sm" onClick={() => openModal('daemon')}>
          <Icon name="plus" size={15} />
          Add daemon
        </Button>
      </div>
      {daemonsLoading && daemons.length === 0 ? (
        <LoadingState fill />
      ) : daemons.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
          <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
            <Icon name="server" size={22} color="var(--text-tertiary)" />
          </span>
          <div className="font-sans text-[15px] font-semibold leading-normal">No daemons connected</div>
          <div className="max-w-[380px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
            Run the daemon on a machine where agents should execute. It connects to the control plane and shows up here.
          </div>
          <Button variant="secondary" size="sm" onClick={() => openModal('daemon')}>
            <Icon name="plus" size={15} />
            Add daemon
          </Button>
        </div>
      ) : (
        <>
          {/* Mobile-only fleet summary strip. */}
          <div className="mb-3 flex items-center gap-2 desktop:hidden">
            <span className="inline-flex items-center gap-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary)">
              <span className="h-2 w-2 rounded-full bg-(--status-online)" />
              {online} online
            </span>
            <span className="inline-flex items-center gap-[6px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary)">
              <span className="h-2 w-2 rounded-full bg-(--status-paused)" />
              {paused} paused
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 desktop:grid-cols-3 desktop:gap-[14px]">
            {daemons.map((m) => (
              <DaemonCard key={m.daemonId} m={m} hosted={hostedByDaemon.get(m.daemonId) ?? 0} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// Bar colour tracks the hotter of the two utilizations (matches the design).
function loadBarColor(load: number): string {
  return load >= 80 ? 'var(--status-paused)' : load >= 60 ? 'var(--amber-500)' : 'var(--brand)'
}

function DaemonCard({ m, hosted }: { m: DaemonRow; hosted: number }) {
  const { orgPath } = useOrgs()
  const router = useRouter()
  const { renameDaemon } = useConsoleData()
  const { openModal } = useModal()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.name)
  const [saving, setSaving] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const s = status(presentedDaemonStatus(m))
  const online = m.status === 'online'
  const load = Math.max(m.cpu, m.mem)
  const barColor = loadBarColor(load)
  const hot = load >= 80
  // Reconnect + delete are offered for any not-serving daemon. Mid-handshake and
  // reconnect-grace states are normalized to offline by the API mapper, so a dead
  // daemon never loses the operator path to detach or reconnect it.
  const offline = m.status === 'offline'
  // Restart is an edit offered while the daemon is online + no op in flight; upgrade
  // additionally needs a newer published version. Both gated on canManageLifecycle.
  const pending = m.lifecycleOp?.status === 'pending'
  const canRestart = online && !pending && m.canManageLifecycle
  const canUpgrade = canRestart && m.upgradeAvailable

  const beginEdit = () => {
    setDraft(m.name)
    setEditing(true)
  }
  const save = async () => {
    const next = draft.trim()
    if (!next || next === m.name) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await renameDaemon(m.daemonId, next)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="card click flex flex-col gap-3 overflow-visible p-[14px] max-desktop:rounded-lg desktop:block desktop:p-0"
      onClick={() => router.push(orgPath(`/daemons/${m.daemonId}`))}
    >
      <div className="flex w-full items-center gap-3 desktop:gap-[11px] desktop:border-b desktop:border-(--border-subtle) desktop:px-4 desktop:py-[15px]">
        <span className="relative flex h-10 w-10 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken) desktop:h-[38px] desktop:w-[38px] desktop:rounded-[9px]">
          <Icon
            name="server"
            size={20}
            color={online ? 'var(--brand)' : 'var(--text-tertiary)'}
            className="desktop:h-[19px] desktop:w-[19px]"
          />
          {/* Mobile puts the status dot on the avatar corner; desktop shows it inline after the name. */}
          <span
            className="absolute -right-[3px] -bottom-[3px] h-3 w-3 rounded-full border-2 border-(--surface-card) desktop:hidden"
            style={{ background: s.dot }}
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[2px] desktop:gap-0">
          <div className="flex min-w-0 items-center gap-[6px] desktop:gap-2">
            {/* Desktop-only: double-click-to-rename name (or the rename input). The plain
                mobile name below keeps the whole card tap-through (no stopPropagation). */}
            {editing ? (
              <input
                autoFocus
                value={draft}
                disabled={saving}
                maxLength={64}
                spellCheck={false}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void save()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save()
                  else if (e.key === 'Escape') setEditing(false)
                }}
                // Cancel the input's border+padding (1.5+1 per side = 5px total)
                // so it occupies the same vertical space as the plain name span
                // — otherwise the taller input grows the card on rename.
                className="-my-[2.5px] hidden w-[150px] rounded-[5px] border-[1.5px] border-(--brand) bg-(--surface-card) px-[6px] py-[1px] font-sans text-[14px] font-semibold leading-normal text-(--text-primary) shadow-[0_0_0_3px_var(--brand-ring)] outline-none desktop:block"
              />
            ) : (
              <span
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={beginEdit}
                title="Double-click to rename"
                className="hidden min-w-0 truncate font-sans text-[14px] font-semibold leading-normal desktop:block"
              >
                {m.name}
              </span>
            )}
            <span className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary) desktop:hidden">
              {m.name}
            </span>
            <RestrictedLock
              show={m.visibility === 'restricted'}
              title="Selected — only shared members can see this daemon"
            />
            <span className="dot hidden flex-none desktop:inline-block" style={{ background: s.dot }} />
          </div>
          {/* Version meta — mobile appends the host (when it differs from the name); desktop shows
              version only. During a lifecycle operation the status badge already says restarting or
              upgrading, so hide the available-upgrade hint instead of repeating the operation here. */}
          <div className="flex min-w-0 items-center gap-[7px]">
            <span className="truncate font-mono text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:text-[11px] desktop:leading-[1.5] desktop:tabular-nums">
              {m.version}
              {m.host && m.host !== m.name && <span className="desktop:hidden">{` · ${m.host}`}</span>}
            </span>
            <DaemonUpgradeBadge
              show={!pending && m.upgradeAvailable}
              latest={m.latestVersion}
              onClick={canUpgrade ? () => openModal('upgradeDaemon', m) : undefined}
            />
          </div>
        </div>
        <span
          className="badge flex-none max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]"
          style={{ background: s.bg, color: s.text }}
        >
          {s.label}
        </span>
        <Icon name="chevron-right" size={16} color="var(--text-tertiary)" className="desktop:hidden" />
        <div className="relative hidden flex-none desktop:block">
          <button
            className="iconbtn h-7 w-7"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            title="Daemon actions"
          >
            <Icon name="ellipsis" size={16} />
          </button>
          {menuOpen && (
            <>
              <div
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                }}
                className="fixed inset-0 z-[45]"
              />
              <div className="dmenu" onClick={(e) => e.stopPropagation()}>
                <button
                  className="dmi"
                  onClick={() => {
                    setMenuOpen(false)
                    beginEdit()
                  }}
                >
                  <Icon name="pencil" size={15} />
                  Rename
                </button>
                {canRestart && (
                  <button
                    className="dmi"
                    onClick={() => {
                      setMenuOpen(false)
                      openModal('restartDaemon', m)
                    }}
                  >
                    <Icon name="refresh-cw" size={15} />
                    Restart
                  </button>
                )}
                {offline && !pending && (
                  <>
                    <button
                      className="dmi"
                      onClick={() => {
                        setMenuOpen(false)
                        openModal('reconnectDaemon', m)
                      }}
                    >
                      <Icon name="refresh-cw" size={15} />
                      Reconnect
                    </button>
                    <div className="dmsep" />
                    <button
                      className="dmi danger"
                      onClick={() => {
                        setMenuOpen(false)
                        openModal('deleteDaemon', m)
                      }}
                    >
                      <Icon name="trash-2" size={15} />
                      Delete
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {/* Body — display:contents at mobile so the bars row and the stats footer
          participate directly in the card's flex-col gap-3; on desktop it is the
          padded section under the header border. */}
      <div className="contents desktop:flex desktop:flex-col desktop:gap-3 desktop:px-4 desktop:py-[14px]">
        <div className="flex w-full gap-4 desktop:flex-col desktop:gap-3">
          <UtilBar label="CPU" pct={m.cpu} color={barColor} hot={hot} />
          <UtilBar label="Memory" mobileLabel="MEM" pct={m.mem} color={barColor} hot={hot} />
        </div>
        <div className="flex w-full gap-5 border-t border-(--border-subtle) pt-[10px] desktop:gap-[18px]">
          {(
            [
              ['agents', String(hosted)],
              ['max agents', m.conns],
              ['last seen', m.uptime]
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <div className="mono text-[14px] leading-normal font-semibold desktop:text-[15px] desktop:leading-[1.5]">
                {value}
              </div>
              <div className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function UtilBar({
  label,
  mobileLabel,
  pct,
  color,
  hot
}: {
  label: string
  /** Shorter label used below 769px (e.g. "MEM"); omitted = same label at both widths. */
  mobileLabel?: string
  pct: number
  color: string
  /** True when the card's hotter utilization is ≥80% — tints the % readout amber. */
  hot: boolean
}) {
  // Clamp to 0..100 — a daemon predating the cpu-normalization fix reports a raw load
  // average, which would otherwise render as e.g. "722%".
  const shown = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="max-desktop:flex-1">
      <div className="mb-[5px] flex justify-between font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
        <span>
          {mobileLabel ? (
            <>
              <span className="hidden desktop:inline">{label}</span>
              <span className="desktop:hidden">{mobileLabel}</span>
            </>
          ) : (
            label
          )}
        </span>
        <span className={hot ? 'mono text-(--amber-500)' : 'mono text-(--text-secondary)'}>{shown}%</span>
      </div>
      <div className="h-[5px] overflow-hidden rounded-[3px] bg-(--surface-active)">
        <div className="h-full rounded-[3px]" style={{ width: `${shown}%`, background: color }} />
      </div>
    </div>
  )
}
