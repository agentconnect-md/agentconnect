'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  POOL_LABEL,
  groupFleetStatus,
  isPoolPlacementKind,
  poolLabel,
  poolFleetStatus,
  presentedDaemonStatus,
  status,
  type DaemonRow,
  type MemberSetRow,
  type StatusInfo
} from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useModal } from '@/components/console/ModalProvider'
import { RestrictedLock } from '@/components/console/VisibilityField'
import { DaemonUpgradeBadge } from '@/components/console/DaemonUpgradeBadge'
import { KubernetesMark, LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'

export default function DaemonsView() {
  const { daemons, daemonsLoading, agents, memberSets, orgSetIds } = useConsoleData()
  const { openModal } = useModal()

  // Hosted-agent count per daemon — agents assigned to it (mirrors the detail
  // view's "Agents hosted"). NOT daemon.agents, which is the active-session count.
  const hostedByDaemon = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of agents) map.set(a.daemon, (map.get(a.daemon) ?? 0) + 1)
    return map
  }, [agents])

  // The pool is ONE entry, not one card per Pod: its members are install-wide
  // infrastructure every org sees, replaced without notice, and nothing here is the
  // org's to rename or detach. Everything else is a machine someone connected.
  // Flagged: where the deployment did not ask for the pool, the page shows the
  // machines only — the CP still serves it, this is whether the console names it.
  const showPool = featureFlagEnabled('daemon-pool')
  // Whose infrastructure the pool IS decides how it reads: the managed install sells it as
  // AgentConnect Cloud, and a self-hosted one is looking at its own cluster.
  const managed = featureFlagEnabled('managed')
  const poolMembers = useMemo(() => (showPool ? daemons.filter((d) => d.pool) : []), [daemons, showPool])
  const ownDaemons = useMemo(() => daemons.filter((d) => !d.pool), [daemons])
  // Pool agents carry the POOL sentinel, never a member id: the Pod holding the duty is
  // ephemeral, so `agentFromDto` maps a set placement to `daemon: POOL_PLACEMENT`. Counting
  // member ids reported an empty pool however many agents were placed on it.
  const poolAgents = useMemo(
    () => (showPool ? agents.filter((a) => isPoolPlacementKind(a.placementKind, a.setId, orgSetIds)).length : 0),
    [agents, orgSetIds, showPool]
  )

  // Whether the groups list renders — lifted out of `GroupsSection` because the "Daemons" label
  // now depends on it too. Flagged: the surface exists in every build and appears only where the
  // deployment asked for it. The Control Plane serves member sets either way — this hides the
  // console entry point, not the feature, which is what keeps one server to reason about.
  const showGroups = featureFlagEnabled('daemon-groups') && (ownDaemons.length > 0 || memberSets.length > 0)

  // Fleet summary for the mobile-only strip below — counted over what the page SHOWS,
  // so the pool contributes one entry rather than one per member.
  const shownStatuses = [
    ...(poolMembers.length > 0 ? [poolFleetStatus(poolMembers)] : []),
    ...ownDaemons.map((d) => d.status)
  ]
  const online = shownStatuses.filter((s) => s === 'online').length
  const paused = shownStatuses.length - online

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
      ) : (
        <>
          {poolMembers.length === 0 && ownDaemons.length === 0 ? (
            <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
              <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
                <Icon name="server" size={22} color="var(--text-tertiary)" />
              </span>
              <div className="font-sans text-[15px] font-semibold leading-normal">No daemons connected</div>
              <div className="max-w-[380px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
                Run the daemon on a machine where agents should execute. It connects to the control plane and shows up
                here.
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
              {poolMembers.length > 0 &&
                (managed ? (
                  <PoolFleetCard members={poolMembers} hosted={poolAgents} />
                ) : (
                  <ClusterFleetCard members={poolMembers} hosted={poolAgents} />
                ))}
              {ownDaemons.length > 0 && (
                <>
                  {/* The section label earns its place only where something else shares the page —
                      the Cloud entry above, or the groups below, which now draw the same card. */}
                  {(poolMembers.length > 0 || showGroups) && (
                    <SectionHeader label="Daemons" count={ownDaemons.length} first={poolMembers.length === 0} />
                  )}
                  <div className={FLEET_GRID}>
                    {ownDaemons.map((m) => (
                      <DaemonCard key={m.daemonId} m={m} hosted={hostedByDaemon.get(m.daemonId) ?? 0} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {/* Last, as the design orders it: the machines are the inventory, a group is what you
              point an agent at once they exist. Outside the empty-fleet branch on purpose: an org
              whose only machines were pool members still manages the groups it already made. */}
          {showGroups && <GroupsSection groups={memberSets} daemons={daemons} />}
        </>
      )}
    </div>
  )
}

/**
 * Both fleet lists ride the same track: a daemon and a group are the two kinds of placement target,
 * so they read as one inventory rather than a card grid above an unrelated table.
 *
 * Auto-fill rather than a column count, because a one-row card has a floor and no ceiling: it needs
 * ~560px before the name truncates into the utilization bars, and a fixed `grid-cols-2` broke at
 * every width below ~1400. `min(…,100%)` keeps that floor from overflowing the narrowest desktop,
 * where one full-width column is the honest answer.
 */
const FLEET_GRID =
  'grid grid-cols-1 gap-3 desktop:grid-cols-[repeat(auto-fill,minmax(min(560px,100%),1fr))] desktop:gap-[14px]'

/** The label + count that separates the page's lists, with an optional action on the right. */
function SectionHeader({
  label,
  count,
  action,
  first = false
}: {
  label: string
  count: number
  action?: ReactNode
  /** Nothing renders above it — drop the separating margin so it does not float. */
  first?: boolean
}) {
  return (
    <div className={`${first ? '' : 'mt-6 '}mb-[9px] flex min-h-[26px] items-center gap-[9px]`}>
      <span className="font-sans text-[13px] font-semibold leading-normal">{label}</span>
      <span className="mono text-[11.5px] text-(--text-tertiary)">{count}</span>
      {action && (
        <>
          <div className="flex-1" />
          {action}
        </>
      )}
    </div>
  )
}

/**
 * Daemon groups — the organization's own member sets (docs/designs/daemon-groups.md §2), drawn as
 * the same card a daemon gets. A group is a placement TARGET whose members are interchangeable,
 * which is what "which machines is this" answers and why the card borrows none of a daemon's
 * telemetry: no group-wide CPU exists to quote. The table this replaced put four columns of chrome
 * around what is usually one row, and below 769px it could only scroll sideways — the group name
 * truncated to four characters.
 *
 * The caller decides whether this renders (`showGroups`): the org has a daemon that could join one,
 * or a group already exists. Before that it answers a question nobody has asked.
 */
function GroupsSection({ groups, daemons }: { groups: MemberSetRow[]; daemons: DaemonRow[] }) {
  const { openModal } = useModal()

  return (
    <>
      <SectionHeader
        label="Daemon groups"
        count={groups.length}
        action={
          <button
            className="inline-flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-medium leading-normal text-(--text-tertiary) hover:text-(--brand)"
            onClick={() => openModal('group')}
          >
            <Icon name="plus" size={13} />
            New group
          </button>
        }
      />
      {groups.length === 0 ? (
        <div className="card px-4 py-[18px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-secondary)">
          Place an agent on a group instead of one daemon and it keeps running when that daemon does not — whichever
          member is serving picks the work up.
        </div>
      ) : (
        <div className={FLEET_GRID}>
          {groups.map((group) => (
            <GroupCard key={group.setId} group={group} daemons={daemons} />
          ))}
        </div>
      )}
    </>
  )
}

function GroupCard({ group, daemons }: { group: MemberSetRow; daemons: DaemonRow[] }) {
  const { openModal } = useModal()
  const { orgPath } = useOrgs()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const s = status(groupFleetStatus(group, daemons))
  const members = daemons.filter((d) => group.memberDaemonIds.includes(d.daemonId))
  const serving = members.filter((d) => d.status === 'online').length
  // Names the members, because "which machines is this" is the question a group answers that a
  // count cannot — falling back to the count once the list would not fit. The agent count rides
  // the same line, where a daemon card carries its own.
  const memberText =
    members.length === 0
      ? 'No daemons yet'
      : members.length <= 2
        ? members.map((d) => d.name).join(', ')
        : `${members.length} daemons · ${serving} serving`
  const meta = `${memberText} · ${group.agentCount} agent${group.agentCount === 1 ? '' : 's'}`

  return (
    // The card opens the group's own page, not the editor: what a reader wants from a group is
    // what runs on it and which members are serving, and renaming it is the rarer of the two.
    // The editor stays one click away, in the card menu and on that page.
    <div
      className="card click flex items-center gap-3 overflow-visible p-[14px] max-desktop:rounded-lg desktop:gap-[11px] desktop:px-4 desktop:py-[13px]"
      onClick={() => router.push(orgPath(`/daemons/groups/${group.setId}`))}
    >
      <span className="relative flex h-10 w-10 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken) desktop:h-[38px] desktop:w-[38px] desktop:rounded-[9px]">
        <Icon
          name="layers"
          size={20}
          color={serving > 0 ? 'var(--brand)' : 'var(--text-tertiary)'}
          className="desktop:h-[19px] desktop:w-[19px]"
        />
        {/* Mobile puts the status dot on the avatar corner; desktop shows it inline after the meta. */}
        <span
          className="absolute -right-[3px] -bottom-[3px] h-3 w-3 rounded-full border-2 border-(--surface-card) desktop:hidden"
          style={{ background: s.dot }}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[2px] desktop:gap-0">
        <span className="truncate font-sans text-[14px] font-semibold leading-normal desktop:text-[13.5px]">
          {group.name}
        </span>
        {/* Wraps to a second line at 375px rather than clipping the agent count — a group's meta
            is longer than a daemon's, and both halves of it are the point. */}
        <span className="line-clamp-2 font-mono text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:line-clamp-1 desktop:text-[11px] desktop:leading-[1.5]">
          {meta}
        </span>
      </div>
      <StatusWord s={s} />
      <span
        className="badge flex-none px-[10px] py-[3px] text-[12px] desktop:hidden"
        style={{ background: s.bg, color: s.text }}
      >
        {s.label}
      </span>
      <Icon name="chevron-right" size={16} color="var(--text-tertiary)" className="desktop:hidden" />
      {/* Desktop-only, as a daemon card's menu is: below 769px the card is a tap target and the
          group's own page carries Edit and Remove, which is where the chevron leads. */}
      <span className="relative hidden flex-none justify-end desktop:flex" onClick={(e) => e.stopPropagation()}>
        <button
          className="iconbtn h-7 w-7"
          aria-label="Group actions"
          title="Group actions"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Icon name="ellipsis" size={16} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-[49]" onClick={() => setMenuOpen(false)} />
            <span className="dmenu top-8">
              <button
                className="dmi"
                onClick={() => {
                  setMenuOpen(false)
                  openModal('group', group)
                }}
              >
                <Icon name="pencil" size={15} />
                Edit group
              </button>
              <span className="dmsep" />
              <button
                className="dmi danger"
                onClick={() => {
                  setMenuOpen(false)
                  openModal('deleteGroup', group)
                }}
              >
                <Icon name="trash-2" size={15} />
                Remove group
              </button>
            </span>
          </>
        )}
      </span>
    </div>
  )
}

/** Desktop's status readout — a dot and the word, on a fixed track so every card's action button
 *  lands on the same column. Mobile carries the filled badge instead. */
function StatusWord({ s }: { s: StatusInfo }) {
  return (
    <span className="hidden w-[76px] flex-none items-center gap-[7px] desktop:flex">
      <span className="dot" style={{ background: s.dot }} />
      <span className="truncate font-sans text-[12.5px] font-medium leading-normal" style={{ color: s.text }}>
        {s.label}
      </span>
    </span>
  )
}

/**
 * The whole pool as one entry on the MANAGED install (design: the Infra screen's `cloudSlot`).
 *
 * Deliberately nothing per-member: a member is a Pod, so its name, host, CPU and memory
 * are cluster churn no reader outside the cluster can act on, and a card each turned a
 * rolling deployment into a fleet of look-alike daemons. What is true of the pool is what
 * shows — is it serving, on what release, and how many agents run there.
 *
 * No utilization bar: the design's is a billing plan's included usage, and inventing that from
 * load telemetry would read as a real quota. `ClusterFleetCard` has one because a self-hoster's
 * ceiling is their cluster's own, which the members do report.
 */
function PoolFleetCard({ members, hosted }: { members: DaemonRow[]; hosted: number }) {
  const { orgPath } = useOrgs()
  const router = useRouter()
  const s = status(poolFleetStatus(members))
  const serving = members.filter((m) => m.status === 'online')
  const online = serving.length > 0
  // Node count and version stay internal — the cloud pool doesn't expose its topology.
  const meta = online ? 'Managed by AgentConnect' : 'Managed by AgentConnect · not serving'
  // Opens CLOUD's own page, never a member's: no member id survives a rollout, so landing on
  // one machine would name the pool after a Pod that is already gone. That page is where the
  // runtimes, models and connections Cloud offers are read.
  const open = () => router.push(orgPath('/daemons/cluster'))

  return (
    <div
      className="card click flex items-center gap-3 overflow-visible p-[14px] max-desktop:rounded-lg desktop:gap-[14px] desktop:px-4 desktop:py-[15px]"
      onClick={open}
    >
      <span className="relative flex h-10 w-10 flex-none items-center justify-center rounded-md bg-(--brand-soft) desktop:h-9 desktop:w-9">
        <Icon name="cloud" size={20} color={online ? 'var(--brand)' : 'var(--text-tertiary)'} />
        {/* Mobile puts the status dot on the avatar corner; desktop shows it inline after the name. */}
        <span
          className="absolute -right-[3px] -bottom-[3px] h-3 w-3 rounded-full border-2 border-(--surface-card) desktop:hidden"
          style={{ background: s.dot }}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[2px] desktop:gap-0">
        <div className="flex min-w-0 items-center gap-[6px] desktop:gap-2">
          <span className="truncate font-sans text-[14px] font-semibold leading-normal desktop:text-[13.5px]">
            {POOL_LABEL}
          </span>
          <span className="dot hidden flex-none desktop:inline-block" style={{ background: s.dot }} />
        </div>
        <div className="truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:text-[11.5px] desktop:leading-[1.5]">
          {meta}
          <span className="desktop:hidden">{` · ${hosted} agent${hosted === 1 ? '' : 's'}`}</span>
        </div>
      </div>
      <div className="hidden flex-none text-right desktop:block">
        <div className="mono text-[14px] leading-normal font-semibold">{hosted}</div>
        <div className="font-sans text-[10.5px] font-normal leading-normal text-(--text-tertiary)">agents on Cloud</div>
      </div>
      <span
        className="badge flex-none max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px]"
        style={{ background: s.bg, color: s.text }}
      >
        {s.label}
      </span>
      <Icon name="chevron-right" size={16} color="var(--text-tertiary)" className="desktop:hidden" />
    </div>
  )
}

// Bar colour tracks the hotter of the two utilizations (matches the design).
function loadBarColor(load: number): string {
  return load >= 80 ? 'var(--status-paused)' : load >= 60 ? 'var(--amber-500)' : 'var(--brand)'
}

/**
 * The same pool on a SELF-HOSTED install (design: the Infra screen's `clusterSlot`).
 *
 * Nothing here is a product the org bought: it is the operator's own cluster, so it is named as
 * one, and the strip quotes the cluster's REAL budget — the agent ceiling its members report,
 * against the agents they are running — rather than a plan's included usage. That is the one
 * number a self-hoster can act on, and the reason the managed card has no bar: there the same
 * pixels would have to mean billing, which no load telemetry can honestly say.
 *
 * Still one entry, never one card per member, and for the unchanged reason: a member is a Pod.
 */
function ClusterFleetCard({ members, hosted }: { members: DaemonRow[]; hosted: number }) {
  const { orgPath } = useOrgs()
  const router = useRouter()
  const s = status(poolFleetStatus(members))
  const serving = members.filter((m) => m.status === 'online')
  const online = serving.length > 0
  // The serving members share a release (they roll together); an idle cluster has no version
  // worth quoting, so the strip drops it rather than naming a Pod that is gone.
  const meta = online
    ? `${serving.length} node${serving.length === 1 ? '' : 's'} · ${serving[0]!.version}`
    : 'no nodes serving'
  // Capacity is the sum of what the serving members will run, matched against what they ARE
  // running — the same pair the CP's placement check uses. A member reporting `maxAgents <= 0`
  // is UNBOUNDED, not a ceiling of zero: a cluster holding one has no finite budget, so the
  // strip names that ∞ rather than quoting a total that says "full" about a pool that can never be.
  const caps = serving.map((m) => Number(m.conns))
  const unbounded = caps.some((c) => !Number.isFinite(c) || c <= 0)
  const capacity = unbounded ? 0 : caps.reduce((sum, c) => sum + c, 0)
  const used = serving.reduce((sum, m) => sum + m.loadAgents, 0)
  const pct = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0
  // Opens the CLUSTER, not a member: no member id survives a rollout, so landing on one
  // machine's page would name the cluster after a Pod that is already gone.
  const open = () => router.push(orgPath('/daemons/cluster'))

  return (
    <div
      className="card click flex items-center gap-3 overflow-visible p-[14px] max-desktop:rounded-lg desktop:gap-[14px] desktop:px-4 desktop:py-[15px]"
      onClick={open}
    >
      <span className="relative flex h-10 w-10 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken) desktop:h-9 desktop:w-9">
        <span className="flex h-[19px] w-[19px]">
          <KubernetesMark />
        </span>
        {/* Mobile puts the status dot on the avatar corner; desktop shows it in the badge. */}
        <span
          className="absolute -right-[3px] -bottom-[3px] h-3 w-3 rounded-full border-2 border-(--surface-card) desktop:hidden"
          style={{ background: s.dot }}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[2px] desktop:gap-0">
        <div className="flex min-w-0 items-center gap-[6px] desktop:gap-2">
          <span className="truncate font-sans text-[14px] font-semibold leading-normal desktop:text-[13.5px]">
            {poolLabel()}
          </span>
          <span
            className="badge hidden flex-none items-center gap-[6px] desktop:inline-flex"
            style={{ background: s.bg, color: s.text }}
          >
            <span className="dot h-[6px] w-[6px]" style={{ background: s.dot }} />
            {s.label}
          </span>
        </div>
        <div className="truncate font-mono text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:text-[11px] desktop:leading-[1.5]">
          {meta}
          <span className="desktop:hidden">{` · ${hosted} agent${hosted === 1 ? '' : 's'}`}</span>
        </div>
      </div>
      <div className="hidden flex-none items-center gap-7 desktop:flex">
        {caps.length > 0 && (
          <div className="w-[184px]">
            <div className="mb-[5px] flex items-baseline justify-between gap-[10px]">
              <span className="mono text-[11.5px] text-(--text-secondary)">
                {used} / {unbounded ? '∞' : capacity}
              </span>
              {/* An unbounded cluster has no fraction to be: the slot reads why, not "0%". */}
              <span className="mono text-[11px] text-(--text-tertiary)">{unbounded ? 'no limit' : `${pct}%`}</span>
            </div>
            <span className="block h-1 overflow-hidden rounded-sm bg-(--surface-active)">
              {!unbounded && (
                <span className="block h-full" style={{ width: `${pct}%`, background: loadBarColor(pct) }} />
              )}
            </span>
            <div className="mt-[5px] font-sans text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
              Sandbox capacity in use
            </div>
          </div>
        )}
        <div className="text-right">
          <div className="mono text-[14px] leading-normal font-semibold">{hosted}</div>
          <div className="mt-[2px] font-sans text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
            agents on cluster
          </div>
        </div>
      </div>
      <span
        className="badge flex-none max-desktop:px-[10px] max-desktop:py-[3px] max-desktop:text-[12px] desktop:hidden"
        style={{ background: s.bg, color: s.text }}
      >
        {s.label}
      </span>
      <Icon name="chevron-right" size={16} color="var(--text-tertiary)" className="desktop:hidden" />
    </div>
  )
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
  const hasActions = m.canEdit || canRestart

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
    // One row per daemon on desktop: identity, the two utilizations, status, actions. Mobile keeps
    // the taller card — a 375px row cannot hold four blocks, and the stats it drops have nowhere
    // else to go until you tap through.
    <div
      className="card click flex flex-col gap-3 overflow-visible p-[14px] max-desktop:rounded-lg desktop:flex-row desktop:items-center desktop:gap-[14px] desktop:px-4 desktop:py-[13px]"
      onClick={() => router.push(orgPath(`/daemons/${m.daemonId}`))}
    >
      <div className="flex w-full items-center gap-3 desktop:w-auto desktop:min-w-0 desktop:flex-1 desktop:gap-[11px]">
        <span className="relative flex h-10 w-10 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken) desktop:h-[38px] desktop:w-[38px] desktop:rounded-[9px]">
          <Icon
            name="server"
            size={20}
            color={online ? 'var(--brand)' : 'var(--text-tertiary)'}
            className="desktop:h-[19px] desktop:w-[19px]"
          />
          {/* Mobile puts the status dot on the avatar corner; desktop shows it inline after the meta. */}
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
                onDoubleClick={m.canEdit ? beginEdit : undefined}
                title={m.canEdit ? 'Double-click to rename' : undefined}
                className="hidden min-w-0 truncate font-sans text-[14px] font-semibold leading-normal desktop:block desktop:text-[13.5px]"
              >
                {m.name}
              </span>
            )}
            <span className="truncate font-sans text-[14px] font-semibold leading-normal text-(--text-primary) desktop:hidden">
              {m.name}
            </span>
            <RestrictedLock
              show={m.visibility === 'restricted'}
              title="Selected — only shared members can see this daemon"
            />
          </div>
          {/* Version meta — mobile appends the host (when it differs from the name); desktop appends
              the hosted-agent count, which is the one stat worth a compact row and which mobile
              carries in the footer below. During a lifecycle operation the status already says
              restarting or upgrading, so hide the available-upgrade hint rather than repeat it. */}
          <div className="flex min-w-0 items-center gap-[7px]">
            <span className="truncate font-mono text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:text-[11px] desktop:leading-[1.5] desktop:tabular-nums">
              {m.version}
              {m.host && m.host !== m.name && <span className="desktop:hidden">{` · ${m.host}`}</span>}
              <span className="hidden desktop:inline">{` · ${hosted} agent${hosted === 1 ? '' : 's'}`}</span>
            </span>
            <DaemonUpgradeBadge
              show={!pending && m.upgradeAvailable}
              latest={m.latestVersion}
              onClick={canUpgrade ? () => openModal('upgradeDaemon', m) : undefined}
            />
          </div>
        </div>
        <span
          className="badge flex-none px-[10px] py-[3px] text-[12px] desktop:hidden"
          style={{ background: s.bg, color: s.text }}
        >
          {s.label}
        </span>
        <Icon name="chevron-right" size={16} color="var(--text-tertiary)" className="desktop:hidden" />
      </div>
      {/* Desktop: both utilizations inline, so the card stays one row tall. */}
      <div className="hidden w-[152px] flex-none flex-col gap-[5px] desktop:flex">
        <MiniBar label="cpu" pct={m.cpu} color={barColor} hot={hot} />
        <MiniBar label="mem" pct={m.mem} color={barColor} hot={hot} />
      </div>
      <StatusWord s={s} />
      {/* Mobile-only: the stacked bars and the stat footer the desktop row folds away. */}
      <div className="flex w-full gap-4 desktop:hidden">
        <UtilBar label="CPU" pct={m.cpu} color={barColor} hot={hot} />
        <UtilBar label="MEM" pct={m.mem} color={barColor} hot={hot} />
      </div>
      <div className="flex w-full gap-5 border-t border-(--border-subtle) pt-[10px] desktop:hidden">
        {(
          [
            ['agents', String(hosted)],
            ['max agents', m.conns],
            ['last seen', m.uptime]
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <div className="mono text-[14px] leading-normal font-semibold">{value}</div>
            <div className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">{label}</div>
          </div>
        ))}
      </div>
      {/* Hidden outright when the caller may do none of it — an empty menu is worse than
          no menu, and every item here is refused by the CP without edit rights. */}
      <div className={hasActions ? 'relative hidden flex-none desktop:block' : 'hidden'}>
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
              {m.canEdit && (
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
              )}
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
              {offline && !pending && m.canEdit && (
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
  )
}

/** Clamp a reported utilization to 0..100 — a daemon predating the cpu-normalization fix reports a
 *  raw load average, which would otherwise render as e.g. "722%". */
function utilPct(pct: number): number {
  return Math.max(0, Math.min(100, Math.round(pct)))
}

/** The desktop card's utilization readout: label, bar and percent on one line, two of them stacked
 *  in the width one `UtilBar` used to need. */
function MiniBar({ label, pct, color, hot }: { label: string; pct: number; color: string; hot: boolean }) {
  const shown = utilPct(pct)
  return (
    <div className="flex items-center gap-[7px]">
      <span className="mono w-[22px] flex-none text-[10.5px] text-(--text-tertiary)">{label}</span>
      <span className="h-[5px] flex-1 overflow-hidden rounded-[3px] bg-(--surface-active)">
        <span className="block h-full rounded-[3px]" style={{ width: `${shown}%`, background: color }} />
      </span>
      <span
        className={`mono w-[30px] flex-none text-right text-[10.5px] ${hot ? 'text-(--amber-500)' : 'text-(--text-secondary)'}`}
      >
        {shown}%
      </span>
    </div>
  )
}

/** The mobile card's utilization readout — label and percent over a full-width bar, two side by
 *  side. Desktop folds the same pair into `MiniBar` so a daemon fits one row. */
function UtilBar({
  label,
  pct,
  color,
  hot
}: {
  label: string
  pct: number
  color: string
  /** True when the card's hotter utilization is ≥80% — tints the % readout amber. */
  hot: boolean
}) {
  const shown = utilPct(pct)
  return (
    <div className="flex-1">
      <div className="mb-[5px] flex justify-between font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
        <span>{label}</span>
        <span className={hot ? 'mono text-(--amber-500)' : 'mono text-(--text-secondary)'}>{shown}%</span>
      </div>
      <div className="h-[5px] overflow-hidden rounded-[3px] bg-(--surface-active)">
        <div className="h-full rounded-[3px]" style={{ width: `${shown}%`, background: color }} />
      </div>
    </div>
  )
}
