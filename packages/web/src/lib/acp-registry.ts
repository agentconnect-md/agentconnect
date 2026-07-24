'use client'

import useSWR from 'swr'

export interface AcpRegistryEntry {
  name: string
  icon: string | null
}

type AcpRegistry = Record<string, AcpRegistryEntry>

const EMPTY_REGISTRY: AcpRegistry = {}
const RUNTIME_ID_ALIASES: Record<string, string> = {
  claude: 'claude-acp',
  codex: 'codex-acp'
}

async function fetchRegistry(url: string): Promise<{ agents: AcpRegistry }> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`ACP Registry returned ${response.status}`)
  return response.json() as Promise<{ agents: AcpRegistry }>
}

export function useAcpRegistry(): AcpRegistry {
  const { data } = useSWR('/api/acp-registry', fetchRegistry, { revalidateOnFocus: false })
  return data?.agents ?? EMPTY_REGISTRY
}

export function acpRuntime(registry: AcpRegistry, runtime: string): AcpRegistryEntry | undefined {
  const id = runtime.toLowerCase()
  const alias = RUNTIME_ID_ALIASES[id]
  const direct = registry[id] ?? (alias ? registry[alias] : undefined)
  if (direct) return direct
  return Object.values(registry).find((entry) => entry.name.toLowerCase() === id)
}
