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

import { useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { groupFleetStatus, isSetPlacementKind, status, type DaemonRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useModal } from '@/components/console/ModalProvider'
import { NotFound } from '@/components/console/NotFound'
import {
  FleetAgentsCard,
  FleetConnectionsCard,
  FleetFact,
  FleetRuntimesCard,
  FleetStat,
  barColor,
  connsHeldBy,
  unionMcpServers,
  unionRuntimes
} from '@/components/console/FleetDetail'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'

export default function GroupDetailView() {
  const { orgPath } = useOrgs()
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { daemons, agents, integrations, memberSets, memberSetsLoading } = useConsoleData()
  const { openModal } = useModal()

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
  const runtimes = useMemo(() => unionRuntimes(serving), [serving])
  const mcpServers = useMemo(() => unionMcpServers(serving), [serving])
  const conns = useMemo(() => connsHeldBy(hosted, integrations), [hosted, integrations])
  // Agents PINNED to a member, per member. They are not the group's — a pinned agent names one
  // machine and stays there — but they are why a member's load is what it is.
  const pinnedByDaemon = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of agents) if (!isSetPlacementKind(a.placementKind)) map.set(a.daemon, (map.get(a.daemon) ?? 0) + 1)
    return map
  }, [agents])

  // Flagged for the same reason the Infra section is: the Control Plane serves member sets
  // either way, so this hides the console entry point, not the feature.
  if (!featureFlagEnabled('daemon-groups') || !group) {
    if (memberSetsLoading && featureFlagEnabled('daemon-groups'))
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
          title="Group not found"
          pre="No daemon group with this id belongs to this organization. It may have been removed, or it belongs to another org."
          actionLabel="Back to daemons"
          actionHref={orgPath('/daemons')}
          searchLabel="Search daemons"
        />
      </div>
    )
  }

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
      ? 'no daemons yet'
      : members.length <= 3
        ? members.map((m) => m.name).join(', ')
        : `${members.length} daemons`

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
              {members.length} daemon{members.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <Icon name="shuffle" size={14} color="var(--text-tertiary)" />
              Any daemon in the group
            </span>
            <span className="inline-flex min-w-0 items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              <Icon name="server" size={14} color="var(--text-tertiary)" />
              <span className="mono truncate text-[12px]">{memberList}</span>
            </span>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => openModal('group', group)}>
          Edit group
        </Button>
      </div>

      <div className="mb-[18px] grid grid-cols-2 gap-[14px] desktop:grid-cols-4">
        <FleetStat
          icon="server"
          label="Daemons serving"
          value={`${serving.length} / ${members.length}`}
          note={members.length === 0 ? 'no members yet' : undefined}
        />
        <FleetStat icon="bot" label="Agents on group" value={String(hosted.length)} />
        <FleetStat icon="plug" label="Connections held" value={String(conns.length)} />
        <FleetStat icon="activity" label="Active sessions" value={String(sessions)} />
      </div>

      <div className="mb-[18px] grid grid-cols-1 items-start gap-[18px] desktop:grid-cols-[1.15fr_1fr]">
        <div className="card">
          <div className="cardhead">
            <span className="cardtitle">Daemons in this group</span>
            <span className="mono ml-auto text-[11px] text-(--text-tertiary)">cpu / memory · pinned</span>
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
                No daemons in this group
              </div>
              <div className="mt-[3px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                A daemon joins from its own page — membership is admitted on the machine whose runtime authority moves.
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="cardhead">
            <span className="cardtitle">Routing</span>
          </div>
          <div className="py-[6px]">
            <FleetFact label="Strategy" value="any member serving" />
            <FleetFact label="Members" value={`${serving.length} serving of ${members.length}`} />
            <FleetFact label="Status" value={s.label} />
            <FleetFact label="Placement" value="group" />
            <FleetFact label="Runtimes" value={String(runtimes.length)} />
            <FleetFact label="MCP servers" value={String(mcpServers.length)} />
          </div>
        </div>
      </div>

      <FleetRuntimesCard
        title="Runtimes across the group"
        runtimes={runtimes}
        agents={hosted}
        empty={
          members.length === 0
            ? 'No runtimes — the group has no members yet.'
            : 'No runtimes reported — no serving member has advertised its runtime profiles yet.'
        }
      />

      <div className="grid grid-cols-1 items-start gap-[18px] desktop:grid-cols-2">
        <FleetAgentsCard
          title="Agents on this group"
          agents={hosted}
          capabilitySource={capabilitySource}
          onOpen={(agentId) => router.push(orgPath(`/agents/${agentId}`))}
          emptyTitle="No agents target this group yet"
          emptyHint={`Place an agent on ${group.name} and it runs on whichever member is serving.`}
        />
        <FleetConnectionsCard
          title="Connections held in the group"
          conns={conns}
          empty="No integration tokens are held on these daemons."
        />
      </div>

      <p className="mt-[14px] max-w-[780px] font-sans text-[12px] font-normal leading-[1.6] text-(--text-tertiary) text-pretty">
        An agent placed on this group keeps running when one member does not — whichever member is serving picks the
        work up. An agent pinned to a member stays pinned there and does not move with the group.
      </p>
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

/** A member's CPU or memory reading. Clamped: a daemon predating the cpu-normalization fix
 *  reports a raw load average, which would otherwise render as e.g. "722%". */
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
