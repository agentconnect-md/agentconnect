import { groupSetIdOf, POOL_PLACEMENT, type DaemonRow, type MemberSetRow } from '@/lib/data'

type DaemonChoiceRow = Pick<DaemonRow, 'pool' | 'daemonId' | 'status' | 'memberSetId'> & {
  caps: Pick<DaemonRow['caps'], 'features'>
}

const moveReady = (daemon: DaemonChoiceRow): boolean =>
  daemon.status === 'online' && daemon.caps.features.includes('agent-move-v1')

export interface EditAgentDaemonChoices<T extends DaemonChoiceRow> {
  poolChoice: T | undefined
  currentPoolChoice: T | undefined
  localChoices: T[]
  /** Does the picker list Cloud at all? Only where the deployment offers the pool — plus, always,
   *  an agent already ON it, whose current placement stays truthful through a rollback. */
  offerPool: boolean
}

export function editAgentDaemonChoices<T extends DaemonChoiceRow>(
  daemons: T[],
  selectedDaemonId: string,
  initialDaemonId: string,
  /** Is the `daemon-pool` flag on for this deployment? */
  poolOffered: boolean
): EditAgentDaemonChoices<T> {
  const selected = daemons.find((daemon) => daemon.daemonId === selectedDaemonId)
  const initial = daemons.find((daemon) => daemon.daemonId === initialDaemonId)
  const poolMembers = daemons.filter((daemon) => daemon.pool)
  const recoveryTarget =
    initial?.pool && !moveReady(initial)
      ? poolMembers.find((daemon) => daemon.daemonId !== initial.daemonId && moveReady(daemon))
      : undefined
  const poolChoice =
    (selected?.pool && selected.daemonId !== initialDaemonId && moveReady(selected) ? selected : undefined) ??
    recoveryTarget ??
    (selected?.pool ? selected : undefined) ??
    (initial?.pool ? initial : undefined) ??
    poolMembers.find(moveReady) ??
    poolMembers[0]
  // Group membership does not disqualify a machine as a target: a `daemon` placement is eligible
  // for exactly that machine either way (daemon-groups.md §3). Only Cloud members are excluded,
  // and above — a pool Pod is a replaceable identity to pin to.
  const localChoices = daemons.filter((daemon) => !daemon.pool)
  localChoices.sort((a, b) => Number(moveReady(b)) - Number(moveReady(a)))
  // The RESOLVED placement, never `placementKind`: a group placement is a `set` too, so classifying
  // by kind alone hands every group-placed agent the Cloud target the deployment just hid.
  const alreadyOnPool = initialDaemonId === POOL_PLACEMENT
  return {
    poolChoice,
    currentPoolChoice:
      initial?.pool && poolChoice?.daemonId !== initial.daemonId && recoveryTarget ? initial : undefined,
    localChoices,
    offerPool: (poolOffered && poolChoice !== undefined) || alreadyOnPool
  }
}

/** The daemon whose reported CAPABILITIES the Edit form reads (runtimes, models, sandbox). A set
 *  target — Cloud or a group — resolves to one live member standing in for the set, the same one the
 *  server would pick; it is never the placement. `POOL_PLACEMENT` matches no row, and resolving it
 *  to nothing is what fell the runtime picker back to the static list and hid the pool's runtimes. */
export function editAgentCapabilitySource<T extends DaemonChoiceRow>(
  daemons: T[],
  selectedDaemonId: string,
  groups: readonly MemberSetRow[],
  poolChoice: T | undefined
): T | undefined {
  const group = groups.find((candidate) => candidate.setId === groupSetIdOf(selectedDaemonId))
  if (group) return daemons.find((daemon) => group.memberDaemonIds.includes(daemon.daemonId) && moveReady(daemon))
  if (selectedDaemonId === POOL_PLACEMENT) return poolChoice
  return daemons.find((daemon) => daemon.daemonId === selectedDaemonId)
}
