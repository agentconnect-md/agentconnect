// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import { useCallback } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { fetchSlackConfig, type SlackConfigDto } from '@/lib/api'
import { MOCK_MODE } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

/**
 * Design/dev with no CP behind the console: pretend the relay, the funnel AND
 * the platform app are all configured, so every pane is reachable. Verbatim the
 * flags the monolith's Slack-only mock branch set — `relayPublicUrl` stays null
 * there too, so the mock manifest keeps its socket shape.
 */
const MOCK_DEPLOYMENT_CONFIG: SlackConfigDto = {
  configured: true,
  durable: true,
  funnelEnabled: true,
  autoAvailable: true,
  accessExpiresAt: null,
  relayAvailable: true,
  relayPublicUrl: null,
  platformInstallAvailable: true,
  updatedAt: null
}

export interface DeploymentConfigProbe {
  /** null ⇒ still in flight (the "Checking your … setup" state). */
  config: SlackConfigDto | null
  /** The probe rejected — every capability reads as unavailable. */
  failed: boolean
  /** Seed the shared cache from a DTO a module just read another way (the
   *  Slack config-token save answers with a fresh one, and its failure path
   *  re-reads the endpoint imperatively). */
  apply(next: SlackConfigDto): void
}

/**
 * The ONE deployment-capability probe behind {@link WizardHost.relayCapability}.
 *
 * `GET /slack/config` is Slack-NAMED but deployment-SCOPED: `relayAvailable` /
 * `relayPublicUrl` describe whether this deployment can terminate public
 * callbacks at all, which is why the Feishu pane already called the same
 * endpoint for its own Request URL. The wizard chassis owns that read; the
 * Slack-funnel flags riding the same DTO (`funnelEnabled`, `autoAvailable`,
 * `platformInstallAvailable`) are Slack module state.
 *
 * Both consumers share ONE SWR key, so the chassis's capability read and the
 * Slack module's funnel read are a single request — the same single request the
 * monolith made from its two hand-written effects.
 *
 * That key is ORG-SCOPED (`consoleKeys.deploymentConfig`) and so is `apply()`.
 * The endpoint answers per organization AND per caller (slack-install.ts's
 * `statusOf(orgIdOf(req), req.principal.userId)`), while `ConsoleShell` keeps
 * one SWR cache above the `[slug]` segment and switching organizations is a
 * client-side `router.push` — so a key without the org id would hand the next
 * organization the previous one's `funnelEnabled` / `autoAvailable` /
 * `platformInstallAvailable` and route the wizard into a flow that cannot
 * succeed there. The monolith could not hit this: it re-read the endpoint from
 * a `useEffect` on every modal open and cached nothing. A null key while the
 * org is still resolving is the same gate every other org-scoped console read
 * uses — the pane waits rather than guessing.
 */
export function useDeploymentConfig(enabled: boolean): DeploymentConfigProbe {
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  const { mutate } = useSWRConfig()
  const { data, error } = useSWR<SlackConfigDto>(
    enabled ? consoleKeys.deploymentConfig(orgId) : null,
    () => (MOCK_MODE ? Promise.resolve(MOCK_DEPLOYMENT_CONFIG) : fetchSlackConfig()),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  const apply = useCallback(
    (next: SlackConfigDto) => {
      // Seed the org the answer actually came from — never a global key that a
      // later organization would read back.
      const key = consoleKeys.deploymentConfig(orgId)
      if (key) void mutate(key, next, { revalidate: false })
    },
    [mutate, orgId]
  )
  return { config: data ?? null, failed: error !== undefined, apply }
}
