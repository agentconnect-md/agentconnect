// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import { useCallback } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { fetchSlackConfig, type SlackConfigDto } from '@/lib/api'
import { MOCK_MODE } from '@/lib/data'

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
 */
const DEPLOYMENT_CONFIG_KEY = ['wizard', 'deployment-config'] as const

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

export function useDeploymentConfig(enabled: boolean): DeploymentConfigProbe {
  const { mutate } = useSWRConfig()
  const { data, error } = useSWR<SlackConfigDto>(
    enabled ? DEPLOYMENT_CONFIG_KEY : null,
    () => (MOCK_MODE ? Promise.resolve(MOCK_DEPLOYMENT_CONFIG) : fetchSlackConfig()),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  const apply = useCallback(
    (next: SlackConfigDto) => void mutate(DEPLOYMENT_CONFIG_KEY, next, { revalidate: false }),
    [mutate]
  )
  return { config: data ?? null, failed: error !== undefined, apply }
}
