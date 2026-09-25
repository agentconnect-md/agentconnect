'use client'

// One of the organization's OWN daemon groups, read as a placement target (design: the
// group/pool detail screen, `gd.*`; daemon-groups.md §2).
//
// A group is not a machine and this page never lets it borrow one's telemetry: it has no
// host, no version, no uptime and no CPU of its own, and the moment it shows those it starts
// reading like whichever member happened to answer. What it DOES have is a membership, and
// everything on the page is either a fact about that set or an aggregate over the members
// that are actually serving — because a member that stopped answering can neither offer a
// runtime nor hold a connection.
//
// The design's pool log tail is absent for the same reason it is absent on the cluster page:
// inventing a log stream would be indistinguishable from real telemetry.

import { useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { groupFleetStatus, isSetPlacementKind, status, type DaemonRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useModal } from '@/components/console/ModalProvider'
import { NotFound } from '@/components/console/NotFound'
import {
  FleetAgentsCard,
  FleetRuntimesCard,
  FleetStat,
  FleetStatColumn,
  HostMissingToggle,
  StrategyTabs,
  barColor,
  imageOnlyRuntimeIds,
  intersectRuntimes
} from '@/components/console/FleetDetail'
import { useStrategyNames } from '@/components/console/ExecutionStrategyField'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import {
  agentStrategyValue,
  groupStrategies,
  HOST_STRATEGY,
  sortStrategies,
  strategyMembers
} from '@/lib/execution-strategy'
import { useOrgs } from '@/lib/org-context'

export default function GroupDetailView() {
  const t = useTranslations('Daemons.groupDetail')
  const tf = useTranslations('Common.fleetDetail')
  const strategyNames = useStrategyNames()
  const { orgPath } = useOrgs()
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { daemons, agents, agentsLoading, daemonsLoading, memberSets, memberSetsLoading } = useConsoleData()
  const { openModal } = useModal()
  const [menuOpen, setMenuOpen] = useState(false)
  const [runtimeTab, setRuntimeTab] = useState<string>(HOST_STRATEGY)
  const [showHostMissing, setShowHostMissing] = useState(false)

  const group = useMemo(() => memberSets.find((g) => g.setId === id), [memberSets, id])
  const members = useMemo(
    () => (group ? daemons.filter((d) => group.memberDaemonIds.includes(d.daemonId)) : []),
    [daemons, group]
  )
  const serving = useMemo(() => members.filter((m) => m.status === 'online'), [members])
  // A group placement carries the set id and no member id — whichever member holds the duty
  // is interchangeable, so matching member ids would report an empty group however many
  // agents are placed on it.
  const hosted = useMemo(
    () => (group ? agents.filter((a) => isSetPlacementKind(a.placementKind) && a.setId === group.setId) : []),
    [agents, group]
  )
  // Agents PINNED to a member, per member. They are not the group's — a pinned agent names one
  // machine and stays there — but they are why a member's load is what it is.
  const pinnedByDaemon = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of agents) if (!isSetPlacementKind(a.placementKind)) map.set(a.daemon, (map.get(a.daemon) ?? 0) + 1)
    return map
  }, [agents])

  if (!group) {
    if (memberSetsLoading)
      return (
        <div className="wrap max-w-[1240px]">
          <LoadingState fill />
        </div>
      )
    return (
      <div className="wrap max-w-[1240px]">
        <NotFound
          icon="server-off"
          kind="GROUP"
          title={t('notFound')}
          pre={t('notFoundDescription')}
          actionLabel={t('backToDaemons')}
          actionHref={orgPath('/daemons')}
          searchLabel={t('searchDaemons')}
        />
      </div>
    )
  }

  // Found, but not yet describable. `memberSets`, `daemons` and `agents` are independent SWR
  // keys and the group's is by far the smallest payload, so a deep link resolves the NAME a round
  // trip before the membership. Rendering there would state "0 / 0 serving · no daemons · no
  // runtimes · no agents" as settled fact and then correct itself, which is worse than waiting.
  if (daemonsLoading || agentsLoading)
    return (
      <div className="wrap max-w-[1240px]">
        <LoadingState fill />
      </div>
    )

  const s = status(groupFleetStatus(group, daemons))
  const online = serving.length > 0
  const sessions = serving.reduce((sum, m) => sum + Number(m.activeSessions ?? 0), 0)
  // One serving member stands in for the set when reading what it can run — the same
  // substitution Add-agent and Edit-agent make (edit-agent-daemon-choice.ts).
  const capabilitySource = serving[0]
  // Names the members while the list still fits, because "which machines is this" is the
  // question a group answers that a count cannot.
  const memberList =
    members.length === 0
      ? t('noDaemonsYet')
      : members.length <= 3
        ? members.map((m) => m.name).join(', ')
        : t('daemonCount', { count: members.length })

  // One tab per strategy any serving member offers, as the picker reads a group; no member table keeps one merged list.
  const placement = groupStrategies(serving.map((m) => m.caps))
  const table = placement.kind === 'table' ? placement.table : undefined
  const runtimeTabs = table ? sortStrategies(Object.keys(table)) : []
  const runtimeStrategy = runtimeTabs.includes(runtimeTab) ? runtimeTab : (runtimeTabs[0] ?? HOST_STRATEGY)
  const tableEntry = table?.[runtimeStrategy]
  const strategyDown = tableEntry?.available === false
  const strategyDownReason = tableEntry && !tableEntry.available ? tableEntry.reason : undefined
  const tabMembers = !table ? serving : strategyDown ? [] : strategyMembers(serving, runtimeStrategy)
  // Intersected, not unioned: an agent here lands on whichever member is serving, so only what they all offer can run.
  const tabRuntimes = intersectRuntimes(tabMembers)
  const imageOnly = table && runtimeStrategy !== HOST_STRATEGY ? imageOnlyRuntimeIds(tabMembers) : new Set<string>()
  const hostMissingIds = new Set(tabRuntimes.filter((rt) => imageOnly.has(rt.runtime)).map((rt) => rt.runtime))
  const runtimes = tabRuntimes.filter((rt) => showHostMissing || !hostMissingIds.has(rt.runtime))
  const runtimeAgents = table ? hosted.filter((a) => agentStrategyValue(a) === runtimeStrategy) : hosted
  const runtimeEmpty =
    members.length === 0
      ? t('noRuntimesNoMembers')
      : serving.length === 0
        ? t('noRuntimesNoServing')
        : strategyDownReason
          ? t('strategyReason', { strategy: strategyNames.name(runtimeStrategy), reason: strategyDownReason })
          : strategyDown
            ? t('strategyUnavailable', { strategy: strategyNames.name(runtimeStrategy) })
            : hostMissingIds.size > 0
              ? tf('expandHostMissing')
              : tabMembers.length === 1
                ? t('noRuntimesUnadvertised')
                : t('noRuntimesIntersection')

  return (
    <div className="wrap max-w-[1240px] px-4 pt-[14px] pb-1 desktop:p-0">
      <div className="mb-5 flex items-start gap-4">
        <span className="relative flex h-13 w-13 flex-none items-center justify-center rounded-lg border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="layers" size={26} color={online ? 'var(--brand)' : 'var(--text-tertiary)'} />
          <span
            className="dot absolute -right-1 -bottom-1 h-[14px] w-[14px] border-[2.5px] border-(--surface-app)"
            style={{ background: s.dot }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-[10px]">
            <h1 className="ptitle mono">{group.name}</h1>
            <span className="badge" style={{ background: s.bg, color: s.text }}>
              <span className="dot h-[6px] w-[6px]" style={{ background: s.dot }} />
              {s.label}
            </span>
            <span className="badge bg-(--surface-active) text-(--text-secondary)">
              {t('daemonCount', { count: members.length })}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex min-w-0 items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <Icon name="server" size={14} color="var(--text-tertiary)" />
              <span className="mono truncate text-[12px]">{memberList}</span>
            </span>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => openModal('group', group)}>
          {t('editGroup')}
        </Button>
        {/* Removal lives here too: the list card's menu is desktop-only, so this is the only path below 769px. */}
        <div className="relative flex-none">
          <button
            className="iconbtn"
            aria-label={t('groupActions')}
            title={t('groupActions')}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="ellipsis" size={16} />
          </button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} className="fixed inset-0 z-45" />
              <div className="dmenu right-0" onClick={(e) => e.stopPropagation()}>
                <button
                  className="dmi danger"
                  onClick={() => {
                    setMenuOpen(false)
                    openModal('deleteGroup', group)
                  }}
                >
                  <Icon name="trash" size={15} />
                  {t('removeGroup')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Band one — what the group holds, beside the machines that hold it. */}
      <div className="mb-[18px] grid grid-cols-1 gap-[14px] desktop:grid-cols-[300px_1fr]">
        <FleetStatColumn>
          <FleetStat icon="bot" label={t('agents')} value={String(hosted.length)} />
          {/* Machine-scoped, unlike its neighbours: the CP counts active sessions per DAEMON, so this
              includes the sessions of agents pinned to these members, which the rest of the page excludes. */}
          <FleetStat icon="activity" label={t('activeSessions')} value={String(sessions)} />
          <FleetStat
            icon="server"
            label={t('daemons')}
            value={`${serving.length} / ${members.length}`}
            note={members.length === 0 ? t('noMembersYet') : t('serving')}
          />
        </FleetStatColumn>

        <div className="card">
          <div className="cardhead">
            <span className="cardtitle">{t('daemonsInGroup')}</span>
            <span className="mono ml-auto text-[11px] text-(--text-tertiary)">
              <span className="hidden desktop:inline">{t('cpuMemory')} · </span>
              {t('pinned')}
            </span>
          </div>
          {members.length > 0 ? (
            members.map((m) => (
              <MemberRow
                key={m.daemonId}
                m={m}
                pinned={pinnedByDaemon.get(m.daemonId) ?? 0}
                onOpen={() => router.push(orgPath(`/daemons/${m.daemonId}`))}
              />
            ))
          ) : (
            <div className="px-4 py-7 text-center">
              <div className="font-sans text-[13px] font-medium leading-normal text-(--text-secondary)">
                {t('noDaemonsInGroup')}
              </div>
              <div className="mt-[3px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                {t('addDaemonsHint')}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Band two — what the group can run, and what runs on it. */}
      <FleetRuntimesCard
        title={t('runtimes')}
        note={t('runtimesNote')}
        runtimes={runtimes}
        agents={runtimeAgents}
        empty={runtimeEmpty}
        headerActions={table && <StrategyTabs tabs={runtimeTabs} value={runtimeStrategy} onChange={setRuntimeTab} />}
        footer={
          <HostMissingToggle
            count={hostMissingIds.size}
            shown={showHostMissing}
            onToggle={() => setShowHostMissing((shown) => !shown)}
          />
        }
      />

      <FleetAgentsCard
        title={t('agentsOnGroup')}
        agents={hosted}
        capabilitySource={capabilitySource}
        onOpen={(agentId) => router.push(orgPath(`/agents/${agentId}`))}
        emptyTitle={t('noAgentsOnGroup')}
        emptyHint={t('placeAgentHint', { group: group.name })}
      />
    </div>
  )
}

/** One member of the group. Clickable, because the machine's own page is where its detail lives. */
function MemberRow({ m, pinned, onOpen }: { m: DaemonRow; pinned: number; onOpen: () => void }) {
  const ms = status(m.status)
  return (
    // Mobile drops the two load bars rather than squeezing six tracks into 375px: which member
    // is serving is the routing fact, and its utilization is on the machine's own page anyway.
    <div
      className="row click grid-cols-[auto_1fr_auto_auto] gap-3 desktop:grid-cols-[auto_1.5fr_.9fr_.8fr_.8fr_auto]"
      onClick={onOpen}
    >
      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
        <Icon name="server" size={13} color={m.status === 'online' ? 'var(--brand)' : 'var(--text-tertiary)'} />
      </span>
      <span className="mono min-w-0 truncate text-[12.5px] font-semibold text-(--text-primary)">{m.name}</span>
      <span className="inline-flex items-center gap-[7px]">
        <span className="dot" style={{ background: ms.dot }} />
        <span className="font-sans text-[12px] font-medium leading-normal" style={{ color: ms.text }}>
          {ms.label}
        </span>
      </span>
      <MemberBar pct={m.cpu} />
      <MemberBar pct={m.mem} />
      <span className="mono text-right text-[12px] text-(--text-primary)">{pinned}</span>
    </div>
  )
}

/** A member's CPU or memory. Clamped — a daemon predating cpu-normalization reports a raw load average. */
function MemberBar({ pct }: { pct: number }) {
  const shown = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <span className="hidden min-w-0 flex-col gap-1 desktop:flex">
      <span className="mono text-[11px] text-(--text-secondary)">{shown}%</span>
      <span className="block h-1 overflow-hidden rounded-[2px] bg-(--surface-active)">
        <span className="block h-full" style={{ width: `${shown}%`, background: barColor(shown) }} />
      </span>
    </span>
  )
}
