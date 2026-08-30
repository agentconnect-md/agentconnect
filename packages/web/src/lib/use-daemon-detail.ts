'use client'

import useSWR from 'swr'
import { consoleKeys } from '@/lib/swr-keys'
import { fetchDaemon } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import type { DaemonRow } from '@/lib/data'

/** Catalog discovery finishes asynchronously after a daemon starts, so an open picker has
 *  to pick the matrix up on its own (runtime-model-catalog.md §7) rather than only on a
 *  remount. Matches the fleet poll: this read is one daemon, and only while a surface that
 *  needs the matrix is mounted. */
const DAEMON_DETAIL_REFRESH_MS = 15_000

/** Overlay the detail read's catalogs onto the fleet row's profiles. The fleet row wins on
 *  everything else — it is the one being polled — so a runtime that has since disappeared
 *  or flipped `authRequired` is not resurrected by a slower detail response. Before the
 *  fleet capability read lands there are no profiles to overlay onto, and the detail's own
 *  are strictly better than none. */
export function mergeDaemonCatalogs(
  fleet: DaemonRow['runtimeModels'],
  detail: DaemonRow['runtimeModels']
): DaemonRow['runtimeModels'] {
  if (fleet.length === 0) return detail
  return fleet.map((profile) => {
    const catalog = detail.find((d) => d.runtime === profile.runtime)?.modelCatalog
    return catalog ? { ...profile, modelCatalog: catalog } : profile
  })
}

/**
 * The one daemon a config surface is configuring, with its runtime profiles' model
 * catalogs. The fleet reads deliberately omit that matrix — every reader of one wants a
 * single daemon at a time, so paying for the whole fleet's matrices on a poll bought
 * nothing.
 *
 * Only the catalogs come from this read. Liveness stays the fleet row's, because callers
 * decide things like move/repair eligibility from the same value and a detail response
 * captured minutes ago must not make an offline daemon look serving.
 */
export function useDaemonDetail(daemon: DaemonRow | undefined): DaemonRow | undefined {
  const { activeOrg } = useOrgs()
  const { data } = useSWR<DaemonRow>(
    daemon && activeOrg?.id ? consoleKeys.daemon(activeOrg.id, daemon.daemonId) : null,
    () => fetchDaemon(daemon!.daemonId),
    { refreshInterval: DAEMON_DETAIL_REFRESH_MS }
  )
  if (!daemon) return undefined
  // SWR can still hold the previous key's answer for a render after the daemon changes.
  if (!data || data.daemonId !== daemon.daemonId) return daemon
  return { ...daemon, runtimeModels: mergeDaemonCatalogs(daemon.runtimeModels, data.runtimeModels) }
}
