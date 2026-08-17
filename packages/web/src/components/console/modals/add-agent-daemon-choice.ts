import { groupSetIdOf, type DaemonRow, type MemberSetRow } from '@/lib/data'

type DaemonChoiceRow = Pick<DaemonRow, 'pool' | 'daemonId' | 'status' | 'memberSetId'>

/** What create submits. A set target — Cloud or one of the org's groups — names the SET, never a
 *  member: pinning a member id is what left an agent stranded on a Pod the next rollout replaced. */
export type AddAgentPlacement = { kind: 'pool' } | { kind: 'set'; setId: string } | { kind: 'daemon'; daemonId: string }

export interface AddAgentDaemonChoice<T extends DaemonChoiceRow> {
  poolAvailable: boolean
  /** Groups with at least one member serving — the only ones an agent can start on. */
  availableGroups: MemberSetRow[]
  /** Every group, in listing order: an unservable one is shown disabled, never hidden. */
  offeredGroups: readonly MemberSetRow[]
  /**
   * The daemon whose reported CAPABILITIES the form reads (runtimes, models, sandbox). For a set
   * target that is one live member standing in for the set, which is exactly what the server will
   * pick anyway; it is never the placement.
   */
  daemon: T | undefined
  daemonId: string | null
  /** Machines that are placement targets in their own right — a daemon in a set is not one. */
  localDaemons: T[]
  placement: AddAgentPlacement | null
  value: string
}

const onlineFirst = <T extends DaemonChoiceRow>(daemons: T[]): T[] =>
  [...daemons].sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online'))

export function addAgentDaemonChoice<T extends DaemonChoiceRow>(
  daemons: T[],
  selectedValue: string,
  groups: readonly MemberSetRow[] = []
): AddAgentDaemonChoice<T> {
  const poolDaemons = daemons.filter((daemon) => daemon.pool && daemon.status === 'online')
  // Group membership does not disqualify a machine as a target: a `daemon` placement is eligible
  // for exactly that machine either way, so it stays the agent's only holder (daemon-groups.md §3).
  // Only Cloud members are excluded, and above — a pool Pod is a replaceable identity to pin to.
  const localDaemons = onlineFirst(daemons.filter((daemon) => !daemon.pool))
  const liveMemberOf = (group: MemberSetRow): T | undefined =>
    daemons.find((daemon) => daemon.status === 'online' && group.memberDaemonIds.includes(daemon.daemonId))
  // Every group is OFFERED; only a serving one is selectable. Hiding an empty group answered the
  // operator's "where is the group I just made?" with silence.
  const availableGroups = groups.filter((group) => liveMemberOf(group) !== undefined)
  const offeredGroups = groups

  const selectedGroup = availableGroups.find((group) => groupSetIdOf(selectedValue) === group.setId)
  const selectedLocal = localDaemons.find((daemon) => daemon.daemonId === selectedValue)
  // Falls back in the order the form offers: the explicit pick, else Cloud, else the first machine.
  const value = selectedGroup
    ? selectedValue
    : (selectedLocal?.daemonId ?? (poolDaemons.length > 0 ? '' : (localDaemons[0]?.daemonId ?? '')))

  // Re-looked up from `value`, never from `selectedLocal`: when nothing was chosen and there is no
  // Cloud, `value` falls back to the first machine — which `selectedLocal` knows nothing about.
  const daemon = selectedGroup
    ? liveMemberOf(selectedGroup)
    : value
      ? localDaemons.find((candidate) => candidate.daemonId === value)
      : poolDaemons[0]
  const placement: AddAgentPlacement | null = selectedGroup
    ? { kind: 'set', setId: selectedGroup.setId }
    : value
      ? daemon
        ? { kind: 'daemon', daemonId: daemon.daemonId }
        : null
      : poolDaemons.length > 0
        ? { kind: 'pool' }
        : null

  return {
    poolAvailable: poolDaemons.length > 0,
    availableGroups,
    offeredGroups,
    daemon,
    daemonId: selectedGroup ? null : value || null,
    localDaemons,
    placement,
    value
  }
}
