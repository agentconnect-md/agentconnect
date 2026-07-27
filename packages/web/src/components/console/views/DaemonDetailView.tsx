'use client'

// Daemon detail — ported from the AgentConnect design (`isDaemonDetail` section).
// The design's fabricated fields (host/ip/os, connect timestamps, a live log tail)
// are intentionally dropped: daemons are LIVE-ONLY, the CP never surfaces a
// hostname to the UI, and inventing a log stream would be indistinguishable from
// real telemetry. Everything rendered here comes from the real DaemonRow + the
// agents placed on this daemon.

import { useState, type ReactNode } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { agentLabel, agentModelDisplay, effectiveAgentStatus, platName, runtimeLabel, status } from '@/lib/data'
import { creatorLabel } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { useModal } from '@/components/console/ModalProvider'
import { VisibilityValue } from '@/components/console/VisibilityField'
import { DaemonLifecycleBadge, daemonLifecycleLabel } from '@/components/console/DaemonLifecycleBadge'
import { DaemonUpgradeBadge } from '@/components/console/DaemonUpgradeBadge'
import { NotFound } from '@/components/console/NotFound'
import { AgentIconView, AgentMark, LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'

// Bar colour tracks the hotter reading (matches the daemons list).
function barColor(pct: number): string {
  return pct >= 80 ? 'var(--status-paused)' : pct >= 60 ? 'var(--amber-500)' : 'var(--brand)'
}

export default function DaemonDetailView() {
  const acpRegistry = useAcpRegistry()
  const { orgPath } = useOrgs()
  const { me } = useProfile()
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { daemons, agents, daemonsLoading } = useConsoleData()
  const { openModal } = useModal()
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)
  // Hover-open model popover over the runtime tiles (design: `rtOpen`).
  const [openRuntime, setOpenRuntime] = useState<string | null>(null)
  // Mobile: tap a runtime row to expand its model list (design: `rtOpen` map —
  // independent toggles, so more than one can be open at once).
  const [expandedRuntimes, setExpandedRuntimes] = useState<Set<string>>(new Set())
  const toggleRuntime = (rid: string) =>
    setExpandedRuntimes((prev) => {
      const next = new Set(prev)
      if (next.has(rid)) next.delete(rid)
      else next.add(rid)
      return next
    })

  const daemon = daemons.find((d) => d.daemonId === id)

  // Live-only: a missing id is a genuine not-found, not a demo fallback.
  if (!daemon) {
    if (daemonsLoading)
      return (
        <div className="wrap max-w-[1240px]">
          <LoadingState fill />
        </div>
      )
    return (
      <div className="wrap max-w-[1240px]">
        <NotFound
          icon="server-off"
          kind="DAEMON"
          title="Daemon not found"
          pre="No daemon "
          chip={id}
          post=" in this organization. It may have been deregistered."
          actionLabel="Back to daemons"
          actionHref={orgPath('/daemons')}
          searchLabel="Search daemons"
        />
      </div>
    )
  }

  const s = status(daemon.status)
  const online = daemon.status === 'online'
  // Reconnect + delete are offered for any not-serving daemon. Mid-handshake and
  // reconnect-grace states are normalized to offline by the API mapper, so a dead
  // daemon never loses the operator path to detach or reconnect it.
  const offline = daemon.status === 'offline'
  // A CP-commanded restart/upgrade is in flight (cli-daemon-split.md §7) when the latest
  // op is still `pending` (status is expiry-projected server-side). While set, the
  // lifecycle actions are hidden (the CP 409s a second one) and a badge shows.
  const op = daemon.lifecycleOp
  const pending = op?.status === 'pending'
  const pendingLabel = op ? daemonLifecycleLabel(op) : ''
  // Restart/upgrade are owner-only fleet ops (server denyNonOwner) — gate the controls on
  // the DTO capability so non-owners never see an action they'd 403 on. Restart needs the
  // daemon live; upgrade additionally needs the resolver to have surfaced other versions.
  const canRestart = online && !pending && daemon.canManageLifecycle
  const canUpgrade = canRestart && daemon.availableVersions.some((v) => v !== daemon.version)

  const hosted = agents.filter((a) => a.daemon === daemon.daemonId)
  const runtimes = daemon.runtimeModels.length
    ? daemon.runtimeModels
    : daemon.caps.runtimes.map((runtime) => ({
        runtime,
        version: '',
        models: [] as string[],
        acpProtocolVersion: null,
        mcpCapabilities: null,
        authRequired: false
      }))
  const seen = daemon.uptime === '—' ? 'never connected' : `last seen ${daemon.uptime} ago`

  const labeled = (label: string, value: ReactNode) => (
    <div className="row grid-cols-[1fr_auto]">
      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{label}</span>
      <span className="mono text-[12.5px]">{value}</span>
    </div>
  )

  const stat = (icon: string, label: string, value: string) => (
    <div className="card stat">
      <div className="statlbl">
        <Icon name={icon} size={14} />
        {label}
      </div>
      <div className="statval">{value}</div>
    </div>
  )

  if (isMobile) {
    // Push-screen body. The Shell push bar already renders [back · daemon name],
    // so this branch starts at the meta strip and keeps every action reachable in
    // the body (Reconnect + edit). Data-honest: no fabricated host/os/ip/heartbeat —
    // the design's "System" card maps onto the real Details + Capabilities fields.
    const metricCells: [string, string][] = [
      ['Agents', String(hosted.length)],
      ['Connections', daemon.conns],
      ['Sessions', daemon.activeSessions],
      // `daemon.uptime` is time-since-last-seen (fmtSeen), not a real uptime — label it honestly.
      ['Last seen', daemon.uptime]
    ]
    const resBars: [string, number][] = [
      ['CPU', daemon.cpu],
      ['Memory', daemon.mem]
    ]
    const sysRows: [string, ReactNode, string][] = [
      ['Hostname', daemon.host, 'var(--text-primary)'],
      ['Status', s.label, online ? 'var(--green-500)' : 'var(--amber-500)'],
      ['Version', daemon.version, 'var(--text-primary)'],
      ...(pending ? ([['Pending', pendingLabel, 'var(--brand)']] as [string, ReactNode, string][]) : [])
    ]
    return (
      <div className="pb-6">
        {/* meta strip */}
        <div className="flex flex-wrap items-center gap-x-[14px] gap-y-2 bg-(--surface-card) px-4 py-3">
          <span
            className="inline-flex items-center gap-[5px] rounded-full px-[10px] py-[3px] font-sans text-[12px] font-semibold leading-normal"
            style={{ background: s.bg, color: s.text }}
          >
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: s.dot }} />
            {s.label}
          </span>
          <span className="inline-flex items-center gap-[6px] whitespace-nowrap font-mono text-[12px] font-medium leading-normal text-(--text-secondary)">
            <Icon name="tag" size={14} color="var(--text-tertiary)" />
            {daemon.version}
          </span>
          {pending ? (
            <DaemonLifecycleBadge op={op} />
          ) : (
            <DaemonUpgradeBadge
              show={daemon.upgradeAvailable}
              latest={daemon.latestVersion}
              size="md"
              onClick={canUpgrade ? () => openModal('upgradeDaemon', daemon) : undefined}
            />
          )}
          <span className="inline-flex items-center gap-[6px] whitespace-nowrap font-mono text-[12px] font-medium leading-normal text-(--text-secondary)">
            <Icon name="timer" size={14} color="var(--text-tertiary)" />
            {seen}
          </span>
        </div>

        {/* action bar — status-aware: online ⇒ restart/upgrade, offline ⇒ reconnect;
            hidden while a lifecycle op is in flight (the pending badge above shows it). */}
        <div className="flex gap-2 bg-(--surface-card) px-4 pb-4">
          {offline && (
            <button
              onClick={() => openModal('reconnectDaemon', daemon)}
              className="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border border-(--border-default) bg-(--surface-card) font-sans text-[14px] font-semibold leading-normal text-(--text-primary)"
            >
              <Icon name="refresh-cw" size={16} />
              Reconnect
            </button>
          )}
          {canRestart && (
            <button
              onClick={() => openModal('restartDaemon', daemon)}
              className="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border border-(--border-default) bg-(--surface-card) font-sans text-[14px] font-semibold leading-normal text-(--text-primary)"
            >
              <Icon name="refresh-cw" size={16} />
              Restart
            </button>
          )}
          <button
            onClick={() => openModal('editDaemon', daemon)}
            aria-label="Edit daemon"
            className="flex h-11 w-11 flex-none cursor-pointer items-center justify-center rounded-md border border-(--border-default) bg-(--surface-card) text-(--text-secondary)"
          >
            <Icon name="pencil" size={16} />
          </button>
        </div>

        {/* metric grid — one seamless bordered card, internal dividers */}
        <div className="mx-4 mt-3 mb-2 grid grid-cols-4 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
          {metricCells.map(([label, value], i) => (
            <div
              key={label}
              className={`flex min-h-13 flex-col justify-between px-[9px] py-[10px] ${
                i < metricCells.length - 1 ? 'border-r border-(--border-subtle)' : ''
              }`}
            >
              <div className="font-sans text-[10px] font-medium leading-[1.3] text-(--text-tertiary)">{label}</div>
              <div className="font-mono text-[16px] font-semibold leading-normal tracking-[-.02em] tabular-nums">
                {value}
              </div>
            </div>
          ))}
        </div>

        {/* runtimes — full-width stacked rows */}
        <div className="mx-4 mt-1 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
          <div className="flex items-center justify-between border-b border-(--border-subtle) px-4 py-3">
            <span className="font-sans text-[14px] font-semibold leading-normal">Runtimes</span>
            <span className="font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
              available here
            </span>
          </div>
          {runtimes.length > 0 ? (
            runtimes.map((rt, i) => {
              const meta = acpRuntime(acpRegistry, rt.runtime)
              const users = hosted.filter(
                (a) => a.runtime === rt.runtime || runtimeLabel(a.runtime) === runtimeLabel(rt.runtime, meta?.name)
              )
              const usage = users.length > 0 ? `${users.length} agent${users.length === 1 ? '' : 's'}` : 'no agents'
              const version = rt.version ? `v${rt.version.replace(/^v/, '')}` : null
              // Expandable when the runtime reported models; the fallback rows
              // built from caps.runtimes carry none.
              const hasDetail = rt.models.length > 0
              const open = hasDetail && expandedRuntimes.has(rt.runtime)
              const rowCls = `box-border flex w-full items-center gap-[10px] border-0 bg-(--surface-card) px-4 py-[11px] text-left ${
                hasDetail ? 'cursor-pointer' : 'cursor-default'
              }`
              const rowInner = (
                <>
                  <span className="imark h-[30px] w-[30px] flex-none rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
                    <AgentMark model={rt.runtime} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span className="font-sans text-[13px] font-semibold leading-normal">
                      {runtimeLabel(rt.runtime, meta?.name)}
                    </span>
                    <span className="font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {version ? `${version} · ${usage}` : usage}
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-[5px]">
                    <span className="whitespace-nowrap rounded-full bg-(--surface-active) px-[9px] py-[2px] font-mono text-[11px] font-semibold leading-normal text-(--text-secondary)">
                      {rt.models.length} model{rt.models.length === 1 ? '' : 's'}
                    </span>
                  </span>
                  {hasDetail && (
                    <Icon name={open ? 'chevron-up' : 'chevron-down'} size={15} color="var(--text-tertiary)" />
                  )}
                </>
              )
              return (
                <div key={rt.runtime} className={i > 0 ? 'border-t border-(--border-subtle)' : undefined}>
                  {hasDetail ? (
                    <button
                      type="button"
                      onClick={() => toggleRuntime(rt.runtime)}
                      aria-expanded={open}
                      className={rowCls}
                    >
                      {rowInner}
                    </button>
                  ) : (
                    <div className={rowCls}>{rowInner}</div>
                  )}
                  {rt.authRequired && (
                    <div
                      title="The runtime rejected the daemon's probe with 'authentication required' — sign in to it on the daemon host. The warning clears on the next probe."
                      className="flex items-center gap-[6px] bg-(--status-paused-soft) px-4 py-[7px] font-sans text-[11.5px] font-medium leading-normal text-(--amber-500)"
                    >
                      <Icon name="triangle-alert" size={12} className="flex-none" />
                      <span className="min-w-0 truncate">Login required — sign in on the daemon host</span>
                    </div>
                  )}
                  {open && (
                    <div className="flex flex-col gap-3 pt-[2px] pr-4 pb-3 pl-14">
                      {rt.models.length > 0 && (
                        <div className="flex flex-col gap-[7px]">
                          <span className="font-sans text-[10px] font-semibold tracking-[.05em] uppercase leading-normal text-(--text-tertiary)">
                            Models
                          </span>
                          {rt.models.map((m) => (
                            <span key={m} className="inline-flex items-center gap-2">
                              <span className="h-[5px] w-[5px] flex-none rounded-full bg-(--border-strong)" />
                              <span className="font-mono text-[12px] font-medium leading-normal text-(--text-primary)">
                                {m}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          ) : (
            <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              No runtimes reported — this daemon hasn&apos;t advertised its runtime profiles yet.
            </div>
          )}
        </div>

        {/* agents on this daemon — stacked rows, tap through to the agent page */}
        <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
          <div className="border-b border-(--border-subtle) px-4 py-3 font-sans text-[14px] font-semibold leading-normal">
            Agents
          </div>
          {hosted.length > 0 ? (
            hosted.map((a, i) => {
              // Daemon status is known here, so gate the agent's effective online on it.
              const as = status(effectiveAgentStatus(a.status, daemon.status))
              return (
                <button
                  key={a.id}
                  onClick={() => router.push(orgPath(`/agents/${a.id}`))}
                  className={`box-border flex w-full cursor-pointer items-center gap-[11px] bg-(--surface-card) px-4 py-3 text-left ${
                    i > 0 ? 'border-t border-(--border-subtle)' : ''
                  }`}
                >
                  <span className="av h-8 w-8 flex-none rounded-[7px]">
                    <AgentIconView icon={a.icon} runtime={a.runtime} size={32} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span className="truncate font-sans text-[13px] font-semibold leading-normal">{agentLabel(a)}</span>
                    <span className="truncate font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                      {agentModelDisplay(daemon, a.runtime, a.model)}
                    </span>
                  </span>
                  <span className="badge flex-none" style={{ background: as.bg, color: as.text }}>
                    <span className="dot h-[6px] w-[6px]" style={{ background: as.dot }} />
                    {as.label}
                  </span>
                </button>
              )
            })
          ) : (
            <div className="px-4 py-7 text-center">
              <div className="font-sans text-[13px] font-medium leading-normal text-(--text-secondary)">
                No agents on this daemon
              </div>
              <div className="mt-[3px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                Deploy an agent here to start handling messages.
              </div>
            </div>
          )}
        </div>

        {/* resources — CPU + Memory bars (no fabricated disk) */}
        <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
          <div className="border-b border-(--border-subtle) px-4 py-3 font-sans text-[14px] font-semibold leading-normal">
            Resources
          </div>
          <div className="flex flex-col gap-[13px] px-4 py-[14px]">
            {resBars.map(([label, pct]) => {
              const shown = Math.max(0, Math.min(100, Math.round(pct)))
              return (
                <div key={label}>
                  <div className="mb-[6px] flex justify-between font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
                    <span>{label}</span>
                    <span className="font-mono text-(--text-secondary)">{shown}%</span>
                  </div>
                  <div className="h-[6px] overflow-hidden rounded-[3px] bg-(--surface-active)">
                    <div className="h-full rounded-[3px]" style={{ width: `${shown}%`, background: barColor(shown) }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* system — real Details fields (no fabricated ip/os/arch/heartbeat) */}
        <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
          <div className="border-b border-(--border-subtle) px-4 py-3 font-sans text-[14px] font-semibold leading-normal">
            System
          </div>
          {sysRows.map(([k, v, color], i) => (
            <div
              key={k}
              className={`flex items-center justify-between gap-4 px-4 py-3 ${
                i > 0 ? 'border-t border-(--border-subtle)' : ''
              }`}
            >
              <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">{k}</span>
              <span className="min-w-0 text-right font-mono text-[12px] font-medium leading-normal" style={{ color }}>
                {v}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-4 border-t border-(--border-subtle) px-4 py-3">
            <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">Created</span>
            <span className="text-right font-mono text-[12px] font-medium leading-normal text-(--text-primary)">
              {creatorLabel(daemon.createdBy, me)}{' '}
              <span className="font-normal whitespace-nowrap text-(--text-tertiary)">· {daemon.createdAt}</span>
            </span>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-(--border-subtle) px-4 py-3">
            <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">Modified</span>
            <span className="text-right font-mono text-[12px] font-medium leading-normal text-(--text-primary)">
              {creatorLabel(daemon.lastModifiedBy, me)}{' '}
              <span className="font-normal whitespace-nowrap text-(--text-tertiary)">· {daemon.lastModifiedAt}</span>
            </span>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-(--border-subtle) px-4 py-3">
            <span className="font-sans text-[14px] font-normal leading-normal text-(--text-tertiary)">Visibility</span>
            {daemon.canManageSharing ? (
              <button
                type="button"
                onClick={() => openModal('editDaemon', daemon)}
                title="Edit visibility"
                className="inline-flex cursor-pointer border-0 bg-transparent p-0"
              >
                <VisibilityValue
                  visibility={daemon.visibility}
                  sharedWith={daemon.sharedWith}
                  createdBy={daemon.createdBy}
                />
              </button>
            ) : (
              <VisibilityValue
                visibility={daemon.visibility}
                sharedWith={daemon.sharedWith}
                createdBy={daemon.createdBy}
              />
            )}
          </div>
        </div>

        {/* capabilities */}
        <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
          <div className="flex items-center justify-between border-b border-(--border-subtle) px-4 py-3">
            <span className="font-sans text-[14px] font-semibold leading-normal">Capabilities</span>
            <span className="font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
              reported on register
            </span>
          </div>
          <div className="py-[6px]">
            {labeled('ACP', daemon.caps.acp ? 'supported' : '—')}
            <ChipRow label="Platforms" items={daemon.caps.platforms.map(platName)} />
            <ChipRow label="Features" items={daemon.caps.features} />
          </div>
        </div>

        {/* delete — offline-only, matching the desktop menu's guard */}
        {offline && (
          <div className="mx-4 mt-3">
            <button
              onClick={() => openModal('deleteDaemon', daemon)}
              className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-(--border-default) bg-(--surface-card) font-sans text-[14px] font-semibold leading-normal text-(--red-600)"
            >
              <Icon name="trash-2" size={16} />
              Delete daemon
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="wrap max-w-[1240px]">
      {/* header */}
      <div className="mb-5 flex items-start gap-4">
        <span className="relative flex h-13 w-13 flex-none items-center justify-center rounded-lg border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="server" size={26} color={online ? 'var(--brand)' : 'var(--text-tertiary)'} />
          <span
            className="dot absolute -right-1 -bottom-1 h-[14px] w-[14px] border-[2.5px] border-(--surface-app)"
            style={{ background: s.dot }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[10px]">
            <h1 className="ptitle" onDoubleClick={() => openModal('editDaemon', daemon)} title="Double-click to edit">
              {daemon.name}
            </h1>
            <span className="badge" style={{ background: s.bg, color: s.text }}>
              <span className="dot h-[6px] w-[6px]" style={{ background: s.dot }} />
              {s.label}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* No hostname chip: the CP seeds the daemon name from the host on first
                register, so host === name === the H1 title — repeating it here is pure
                duplication. The labeled "Hostname" row in the Details card still carries
                it, unambiguously. */}
            <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <Icon name="tag" size={14} color="var(--text-tertiary)" />
              <span className="mono text-[12px]">{daemon.version}</span>
            </span>
            {pending ? (
              <DaemonLifecycleBadge op={op} />
            ) : (
              <DaemonUpgradeBadge
                show={daemon.upgradeAvailable}
                latest={daemon.latestVersion}
                size="md"
                onClick={canUpgrade ? () => openModal('upgradeDaemon', daemon) : undefined}
              />
            )}
            <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <Icon name="timer" size={14} color="var(--text-tertiary)" />
              {seen}
            </span>
          </div>
        </div>
        <div className="relative flex-none">
          <button className="iconbtn" onClick={() => setMenuOpen((v) => !v)} title="Daemon actions">
            <Icon name="ellipsis" size={16} />
          </button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} className="fixed inset-0 z-45" />
              <div className="dmenu right-0" onClick={(e) => e.stopPropagation()}>
                <button
                  className="dmi"
                  onClick={() => {
                    setMenuOpen(false)
                    openModal('editDaemon', daemon)
                  }}
                >
                  <Icon name="pencil" size={15} />
                  Edit
                </button>
                {canRestart && (
                  <button
                    className="dmi"
                    onClick={() => {
                      setMenuOpen(false)
                      openModal('restartDaemon', daemon)
                    }}
                  >
                    <Icon name="refresh-cw" size={15} />
                    Restart
                  </button>
                )}
                {offline && (
                  <>
                    <button
                      className="dmi"
                      onClick={() => {
                        setMenuOpen(false)
                        openModal('reconnectDaemon', daemon)
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
                        openModal('deleteDaemon', daemon)
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

      {/* metric strip */}
      <div className="mb-[18px] grid grid-cols-2 gap-[14px] desktop:grid-cols-4">
        {stat('bot', 'Agents hosted', String(hosted.length))}
        {stat('layers', 'Max agents', daemon.conns)}
        {stat('activity', 'Active sessions', daemon.activeSessions)}
        {stat('timer', 'Last seen', daemon.uptime)}
      </div>

      {/* runtimes */}
      <div className="card mb-[18px]">
        <div className="cardhead">
          <span className="cardtitle">Runtimes</span>
          <span className="mono ml-auto text-[11px] text-(--text-tertiary)">available on this daemon</span>
        </div>
        {runtimes.length > 0 ? (
          <div className="grid grid-cols-3 gap-3 px-4 py-[14px]">
            {runtimes.map((rt) => {
              const meta = acpRuntime(acpRegistry, rt.runtime)
              // Agents on this daemon driven by this runtime (id namespaces differ
              // across daemon generations — 'claude' vs 'claude-acp' — so match on
              // the display family, not the raw id).
              const users = hosted.filter(
                (a) => a.runtime === rt.runtime || runtimeLabel(a.runtime) === runtimeLabel(rt.runtime, meta?.name)
              )
              const usage = users.length > 0 ? `${users.length} agent${users.length === 1 ? '' : 's'}` : 'no agents'
              // The runtime's own release (e.g. claude-agent-acp 0.54.1), stamped by
              // the daemon from the ACP registry doc; '' until reported.
              const version = rt.version ? `v${rt.version.replace(/^v/, '')}` : null
              const open = openRuntime === rt.runtime && rt.models.length > 0
              return (
                <div
                  key={rt.runtime}
                  onMouseEnter={() => setOpenRuntime(rt.runtime)}
                  onMouseLeave={() => setOpenRuntime(null)}
                  className="relative self-start rounded-[9px] border border-(--border-subtle)"
                >
                  <div className="rthead flex items-center gap-[11px] rounded-md px-[13px] py-3">
                    <span className="imark h-[30px] w-[30px]">
                      <AgentMark model={rt.runtime} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-sans text-[13px] font-semibold leading-normal">
                        {runtimeLabel(rt.runtime, meta?.name)}
                      </div>
                      <div className="mono text-[11px] text-(--text-tertiary)">
                        {version ? `${version} · ${usage}` : usage}
                      </div>
                    </div>
                    <span className="flex flex-none items-center gap-[6px]">
                      <span className="badge bg-(--surface-active) text-(--text-secondary)">
                        {rt.models.length} model{rt.models.length === 1 ? '' : 's'}
                      </span>
                    </span>
                  </div>
                  {rt.authRequired && (
                    <div
                      title="The runtime rejected the daemon's probe with 'authentication required' — sign in to it on the daemon host. The warning clears on the next probe."
                      className="flex items-center gap-[6px] rounded-b-[8px] bg-(--status-paused-soft) px-[13px] py-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--amber-500)"
                    >
                      <Icon name="triangle-alert" size={12} className="flex-none" />
                      <span className="min-w-0 truncate">Login required — sign in on the daemon host</span>
                    </div>
                  )}
                  {open && (
                    <div className="absolute top-[calc(100%_+_4px)] right-0 left-0 z-40 overflow-hidden rounded-[9px] border border-(--border-default) bg-(--surface-card) py-1 shadow-(--shadow-lg)">
                      {rt.models.length > 0 && (
                        <>
                          <div className="px-[13px] pt-[7px] pb-1 font-sans text-[10px] font-semibold tracking-[.05em] uppercase leading-normal text-(--text-tertiary)">
                            Models
                          </div>
                          {rt.models.map((m) => (
                            <div key={m} className="flex items-center gap-2 px-[13px] py-[5px]">
                              <span className="mono min-w-0 flex-1 truncate text-[11.5px]">{m}</span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            No runtimes reported — this daemon hasn&apos;t advertised its runtime profiles yet.
          </div>
        )}
      </div>

      <div className="grid grid-cols-[340px_1fr] items-start gap-[18px]">
        {/* left column */}
        <div className="flex flex-col gap-[18px]">
          <div className="card">
            <div className="cardhead">
              <span className="cardtitle">Resources</span>
            </div>
            <div className="flex flex-col gap-[14px] px-4 py-[15px]">
              <UtilBar label="CPU" pct={daemon.cpu} />
              <UtilBar label="Memory" pct={daemon.mem} />
            </div>
          </div>
          <div className="card">
            <div className="cardhead">
              <span className="cardtitle">Details</span>
            </div>
            <div className="py-[6px]">
              {labeled('Hostname', daemon.host)}
              {labeled('Status', s.label)}
              {labeled('Version', daemon.version)}
              {pending && labeled('Pending', pendingLabel)}
              {labeled('Last seen', daemon.uptime)}
              <div className="row grid-cols-[auto_1fr] gap-3">
                <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">Created</span>
                <span className="min-w-0 text-right font-sans text-[12.5px] font-medium leading-normal">
                  {creatorLabel(daemon.createdBy, me)}{' '}
                  <span className="mono font-normal whitespace-nowrap text-(--text-tertiary)">
                    · {daemon.createdAt}
                  </span>
                </span>
              </div>
              <div className="row grid-cols-[auto_1fr] gap-3">
                <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
                  Modified
                </span>
                <span className="min-w-0 text-right font-sans text-[12.5px] font-medium leading-normal">
                  {creatorLabel(daemon.lastModifiedBy, me)}{' '}
                  <span className="mono font-normal whitespace-nowrap text-(--text-tertiary)">
                    · {daemon.lastModifiedAt}
                  </span>
                </span>
              </div>
              <div className="row grid-cols-[auto_1fr] gap-3">
                <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
                  Visibility
                </span>
                <span className="flex min-w-0 justify-end">
                  {daemon.canManageSharing ? (
                    <button
                      type="button"
                      onClick={() => openModal('editDaemon', daemon)}
                      title="Edit visibility"
                      className="inline-flex cursor-pointer border-0 bg-transparent p-0"
                    >
                      <VisibilityValue
                        visibility={daemon.visibility}
                        sharedWith={daemon.sharedWith}
                        createdBy={daemon.createdBy}
                      />
                    </button>
                  ) : (
                    <VisibilityValue
                      visibility={daemon.visibility}
                      sharedWith={daemon.sharedWith}
                      createdBy={daemon.createdBy}
                    />
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* right column */}
        <div className="flex flex-col gap-[18px]">
          <div className="card">
            <div className="cardhead justify-between">
              <span className="cardtitle">Agents</span>
            </div>
            {hosted.length > 0 ? (
              <>
                <div className="row h grid-cols-[auto_1.6fr_1fr_auto] gap-3">
                  <span />
                  <span>Agent</span>
                  <span>Model</span>
                  <span>Status</span>
                </div>
                {hosted.map((a) => {
                  // On this page we know the daemon's status, so gate the agent's online.
                  const as = status(effectiveAgentStatus(a.status, daemon.status))
                  return (
                    <div
                      key={a.id}
                      className="row click grid-cols-[auto_1.6fr_1fr_auto] gap-3"
                      onClick={() => router.push(orgPath(`/agents/${a.id}`))}
                    >
                      <span className="av h-7 w-7 rounded-[7px]">
                        <AgentIconView icon={a.icon} runtime={a.runtime} size={28} />
                      </span>
                      <span className="min-w-0 truncate font-sans text-[13px] font-semibold leading-normal">
                        {agentLabel(a)}
                      </span>
                      <span className="min-w-0 truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
                        {agentModelDisplay(daemon, a.runtime, a.model)}
                      </span>
                      <span className="badge" style={{ background: as.bg, color: as.text }}>
                        <span className="dot h-[6px] w-[6px]" style={{ background: as.dot }} />
                        {as.label}
                      </span>
                    </div>
                  )
                })}
              </>
            ) : (
              <div className="px-4 py-7 text-center">
                <div className="font-sans text-[13px] font-medium leading-normal text-(--text-secondary)">
                  No agents on this daemon
                </div>
                <div className="mt-[3px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  Deploy an agent here to start handling messages.
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="cardhead">
              <span className="cardtitle">Capabilities</span>
              <span className="mono ml-auto text-[11px] text-(--text-tertiary)">reported on register</span>
            </div>
            <div className="py-[6px]">
              {labeled('ACP', daemon.caps.acp ? 'supported' : '—')}
              <ChipRow label="Platforms" items={daemon.caps.platforms.map(platName)} />
              <ChipRow label="Features" items={daemon.caps.features} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function UtilBar({ label, pct }: { label: string; pct: number }) {
  // Clamp to 0..100 — a daemon predating the cpu-normalization fix reports a raw
  // load average, which would otherwise render as e.g. "722%".
  const shown = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div>
      <div className="mb-[6px] flex justify-between font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
        <span>{label}</span>
        <span className="mono text-(--text-secondary)">{shown}%</span>
      </div>
      <div className="h-[6px] overflow-hidden rounded-[3px] bg-(--surface-active)">
        <div className="h-full rounded-[3px]" style={{ width: `${shown}%`, background: barColor(shown) }} />
      </div>
    </div>
  )
}

function ChipRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="row grid-cols-[1fr_auto] gap-3">
      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{label}</span>
      {items.length > 0 ? (
        <span className="flex flex-wrap justify-end gap-[6px]">
          {items.map((it) => (
            <span key={it} className="scope">
              {it}
            </span>
          ))}
        </span>
      ) : (
        <span className="mono text-[12.5px] text-(--text-tertiary)">—</span>
      )}
    </div>
  )
}
