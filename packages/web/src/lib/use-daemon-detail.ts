'use client'

import useSWR from 'swr'
import { consoleKeys } from '@/lib/swr-keys'
import { fetchDaemon } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import type { DaemonRow } from '@/lib/data'

/**
 * The one daemon a config surface is configuring, read in full so its runtime profiles
 * carry their model catalogs. The fleet reads deliberately omit those — every reader of a
 * catalog wants a single daemon at a time, so paying for the whole fleet's matrices on a
 * poll bought nothing.
 *
 * Returns the fleet row unchanged while the read is in flight or if it fails, so a picker
 * degrades to "no catalog" (the static tables) instead of going blank.
 */
export function useDaemonDetail(daemon: DaemonRow | undefined): DaemonRow | undefined {
  const { activeOrg } = useOrgs()
  const { data } = useSWR<DaemonRow>(
    daemon && activeOrg?.id ? consoleKeys.daemon(activeOrg.id, daemon.daemonId) : null,
    () => fetchDaemon(daemon!.daemonId)
  )
  return data ?? daemon
}
