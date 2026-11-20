// No 'use client' here: reached only from the console's client trees, exactly like `registry.ts`.

import { useCallback } from 'react'
import useSWR from 'swr'
import { MOCK_MODE } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import type { WebPlatformModule } from './contract'
import { platformOffered } from './host-projections'
import { platformRegistry } from './registry'

/** The modules whose offer a deployment setting decides, as `WebPlatformModule.offered`. */
const READ_OFFERS = platformRegistry.all().filter((module) => module.offered)

/** Each module's answer for one organization; a failed read offers nothing. */
export async function readPlatformOffers(
  modules: readonly WebPlatformModule[],
  orgId: string
): Promise<ReadonlySet<string>> {
  const answers = await Promise.all(
    modules.map(async (module) => ((await module.offered!(orgId).catch(() => false)) ? module.platformId : null))
  )
  return new Set(answers.filter((id): id is string => id !== null))
}

/** The install picker's offer predicate: a module's flag, then the deployment's own answer where the module reads one; unread is not offered. */
export function useOfferedPlatform(): (key: string) => boolean {
  const { activeOrg } = useOrgs()
  // Design mode has no Control Plane to ask, so every flagged platform is offered.
  const reading = MOCK_MODE ? [] : READ_OFFERS.filter((module) => platformOffered(module.platformId))
  const { data } = useSWR(
    reading.length > 0 ? consoleKeys.platformOffers(activeOrg?.id) : null,
    ([, orgId]: readonly [string, string, string]) => readPlatformOffers(reading, orgId),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  return useCallback(
    (key: string) =>
      platformOffered(key) && (MOCK_MODE || !platformRegistry.get(key)?.offered || (data?.has(key) ?? false)),
    [data]
  )
}
