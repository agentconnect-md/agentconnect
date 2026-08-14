import type { DaemonRow } from '@/lib/data'

type DaemonChoiceRow = Pick<DaemonRow, 'cloud' | 'daemonId' | 'status'> & {
  caps: Pick<DaemonRow['caps'], 'features'>
}

const moveReady = (daemon: DaemonChoiceRow): boolean =>
  daemon.status === 'online' && daemon.caps.features.includes('agent-move-v1')

export interface EditAgentDaemonChoices<T extends DaemonChoiceRow> {
  cloudChoice: T | undefined
  currentCloudChoice: T | undefined
  localChoices: T[]
}

export function editAgentDaemonChoices<T extends DaemonChoiceRow>(
  daemons: T[],
  selectedDaemonId: string,
  initialDaemonId: string
): EditAgentDaemonChoices<T> {
  const selected = daemons.find((daemon) => daemon.daemonId === selectedDaemonId)
  const initial = daemons.find((daemon) => daemon.daemonId === initialDaemonId)
  const cloudMembers = daemons.filter((daemon) => daemon.cloud)
  const recoveryTarget =
    initial?.cloud && !moveReady(initial)
      ? cloudMembers.find((daemon) => daemon.daemonId !== initial.daemonId && moveReady(daemon))
      : undefined
  const cloudChoice =
    (selected?.cloud && selected.daemonId !== initialDaemonId && moveReady(selected) ? selected : undefined) ??
    recoveryTarget ??
    (selected?.cloud ? selected : undefined) ??
    (initial?.cloud ? initial : undefined) ??
    cloudMembers.find(moveReady) ??
    cloudMembers[0]
  const localChoices = daemons.filter((daemon) => !daemon.cloud)
  localChoices.sort((a, b) => Number(moveReady(b)) - Number(moveReady(a)))
  return {
    cloudChoice,
    currentCloudChoice:
      initial?.cloud && cloudChoice?.daemonId !== initial.daemonId && recoveryTarget ? initial : undefined,
    localChoices
  }
}
