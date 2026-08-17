import type { DaemonRow } from '@/lib/data'

type DaemonChoiceRow = Pick<DaemonRow, 'pool' | 'daemonId' | 'status' | 'memberSetId'> & {
  caps: Pick<DaemonRow['caps'], 'features'>
}

const moveReady = (daemon: DaemonChoiceRow): boolean =>
  daemon.status === 'online' && daemon.caps.features.includes('agent-move-v1')

export interface EditAgentDaemonChoices<T extends DaemonChoiceRow> {
  poolChoice: T | undefined
  currentPoolChoice: T | undefined
  localChoices: T[]
}

export function editAgentDaemonChoices<T extends DaemonChoiceRow>(
  daemons: T[],
  selectedDaemonId: string,
  initialDaemonId: string
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
  // A daemon in a group is served THROUGH the group (daemon-groups.md §3), so it is not a target
  // of its own: submitting one is a `daemon` placement the control plane refuses. The agent's
  // CURRENT machine stays listed regardless — an option that names where the agent already is can
  // never be a placement the server has not already accepted.
  const localChoices = daemons.filter(
    (daemon) => !daemon.pool && (!daemon.memberSetId || daemon.daemonId === initialDaemonId)
  )
  localChoices.sort((a, b) => Number(moveReady(b)) - Number(moveReady(a)))
  return {
    poolChoice,
    currentPoolChoice:
      initial?.pool && poolChoice?.daemonId !== initial.daemonId && recoveryTarget ? initial : undefined,
    localChoices
  }
}
