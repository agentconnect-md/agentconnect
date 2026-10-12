import { AgentModelKeyProvider } from '@agentconnect.md/protocol/provider-key'
import useSWR from 'swr'
import { fetchProviderKeys } from '@/lib/api'
import type { DaemonRow } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

type ModelSource = Pick<DaemonRow, 'runtimeModels'>

// Runtime aliases share credentials with their canonical install; OpenCode names the provider in each model id.
function modelProvider(runtime: string, model: string): string | undefined {
  switch (runtime.replace(/-acp$/, '')) {
    case 'claude':
      return 'anthropic'
    case 'codex':
      return 'openai'
    case 'opencode':
      return model.includes('/') ? model.split('/', 1)[0] : undefined
  }
}

export function savedModelSource(source: ModelSource | undefined, configured: readonly string[]): ModelSource {
  const providers = new Set(configured.filter((provider) => AgentModelKeyProvider.safeParse(provider).success))
  return {
    runtimeModels: (source?.runtimeModels ?? []).flatMap((profile) => {
      const models = profile.models.filter((model) =>
        providers.has(modelProvider(profile.aliasOf ?? profile.runtime, model) ?? '')
      )
      return models.length ? [{ ...profile, models, authRequired: false }] : []
    })
  }
}

export function useSavedModelSource(source: ModelSource | undefined, enabled: boolean) {
  const { activeOrg } = useOrgs()
  const { data, error, isValidating, mutate } = useSWR(
    enabled ? consoleKeys.providerKeys(activeOrg?.id) : null,
    ([, orgId]) => fetchProviderKeys(orgId)
  )
  const status = !enabled
    ? 'ready'
    : (!data && !error) || (error && isValidating)
      ? 'loading'
      : error
        ? 'error'
        : 'ready'
  return {
    source:
      enabled && data
        ? savedModelSource(
            source,
            data.filter((entry) => entry.configured).map((entry) => entry.provider)
          )
        : source,
    status,
    retry: () => void mutate()
  } as const
}
