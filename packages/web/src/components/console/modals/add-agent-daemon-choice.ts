import type { DaemonRow } from '@/lib/data'

type DaemonChoiceRow = Pick<DaemonRow, 'cloud' | 'daemonId' | 'status'>

export interface AddAgentDaemonChoice<T extends DaemonChoiceRow> {
  cloudAvailable: boolean
  daemon: T | undefined
  daemonId: string | null
  localDaemons: T[]
  value: string
}

const onlineFirst = <T extends DaemonChoiceRow>(daemons: T[]): T[] =>
  [...daemons].sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online'))

export function addAgentDaemonChoice<T extends DaemonChoiceRow>(
  daemons: T[],
  selectedDaemonId: string
): AddAgentDaemonChoice<T> {
  const cloudDaemons = onlineFirst(daemons.filter((daemon) => daemon.cloud))
  const localDaemons = onlineFirst(daemons.filter((daemon) => !daemon.cloud))
  const selectedLocal = localDaemons.find((daemon) => daemon.daemonId === selectedDaemonId)
  const value = selectedLocal?.daemonId ?? (cloudDaemons.length > 0 ? '' : (localDaemons[0]?.daemonId ?? ''))

  return {
    cloudAvailable: cloudDaemons.length > 0,
    daemon: value ? localDaemons.find((candidate) => candidate.daemonId === value) : cloudDaemons[0],
    daemonId: value || null,
    localDaemons,
    value
  }
}
