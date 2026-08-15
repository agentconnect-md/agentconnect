import type { DaemonRow } from '@/lib/data'

type DaemonChoiceRow = Pick<DaemonRow, 'pool' | 'daemonId' | 'status'>

export interface AddAgentDaemonChoice<T extends DaemonChoiceRow> {
  poolAvailable: boolean
  daemon: T | undefined
  daemonId: string | null
  localDaemons: T[]
  /** What create submits. Cloud is the POOL, not one of its members: pinning a member id here is
   *  what left an agent stranded on a Pod the next rollout replaced. */
  placement: { kind: 'pool' } | { kind: 'daemon'; daemonId: string } | null
  value: string
}

const onlineFirst = <T extends DaemonChoiceRow>(daemons: T[]): T[] =>
  [...daemons].sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online'))

export function addAgentDaemonChoice<T extends DaemonChoiceRow>(
  daemons: T[],
  selectedDaemonId: string
): AddAgentDaemonChoice<T> {
  const poolDaemons = daemons.filter((daemon) => daemon.pool && daemon.status === 'online')
  const localDaemons = onlineFirst(daemons.filter((daemon) => !daemon.pool))
  const selectedLocal = localDaemons.find((daemon) => daemon.daemonId === selectedDaemonId)
  const value = selectedLocal?.daemonId ?? (poolDaemons.length > 0 ? '' : (localDaemons[0]?.daemonId ?? ''))
  const daemon = value ? localDaemons.find((candidate) => candidate.daemonId === value) : poolDaemons[0]

  return {
    poolAvailable: poolDaemons.length > 0,
    daemon,
    daemonId: value || null,
    localDaemons,
    placement: value
      ? daemon
        ? { kind: 'daemon', daemonId: daemon.daemonId }
        : null
      : poolDaemons.length > 0
        ? { kind: 'pool' }
        : null,
    value
  }
}
