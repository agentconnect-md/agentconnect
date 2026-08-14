import type { DaemonRow } from '@/lib/data'

type DaemonChoiceRow = Pick<DaemonRow, 'cloud' | 'daemonId' | 'status'> & {
  caps: Pick<DaemonRow['caps'], 'features'>
}

const moveReady = (daemon: DaemonChoiceRow): boolean =>
  daemon.status === 'online' && daemon.caps.features.includes('agent-move-v1')

export function editAgentDaemonChoices<T extends DaemonChoiceRow>(
  daemons: T[],
  selectedDaemonId: string,
  initialDaemonId: string
): T[] {
  const selected = daemons.find((daemon) => daemon.daemonId === selectedDaemonId)
  const initial = daemons.find((daemon) => daemon.daemonId === initialDaemonId)
  const cloudMembers = daemons.filter((daemon) => daemon.cloud)
  const cloudChoice =
    (selected?.cloud ? selected : undefined) ??
    (initial?.cloud ? initial : undefined) ??
    cloudMembers.find(moveReady) ??
    cloudMembers[0]
  const localChoices = daemons.filter((daemon) => !daemon.cloud)
  localChoices.sort((a, b) => Number(moveReady(b)) - Number(moveReady(a)))
  return cloudChoice ? [cloudChoice, ...localChoices] : localChoices
}
