const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

interface RawRegistryEntry {
  id?: unknown
  name?: unknown
  icon?: unknown
}

// Curated ACP runtimes that are not guaranteed to exist in the public ACP
// registry (mirrors the ids in packages/daemon CURATED_RUNTIME_CATALOG). Their
// icons live here because the web console is their only consumer — the daemon
// uses these ids to launch processes, not to display marks. Keep the ids in
// sync with the daemon catalog when adding a runtime.
const CURATED_AGENTS: Record<string, { name: string; icon: string | null }> = {
  'hermes-agent': {
    name: 'Hermes Agent',
    icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/hermesagent.svg'
  },
  'kiro-cli': {
    name: 'Kiro CLI',
    icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/kiro-color.svg'
  },
  zeroclaw: { name: 'ZeroClaw', icon: 'https://www.zeroclawlabs.ai/images/zeroclawlabs.png' },
  omp: {
    name: 'Oh My Pi',
    icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAMAAABF0y+mAAAAaVBMVEVHcEwPChQPChQPChQPChQPChQPChQAAADhS8zUTdzDTuu2T/qoT/2cUP3HS96xTO+VX/13L4iNMouVO66FQM1hNKBbQJ5ZKYAKCQ4hECmPcf1TVJyIgPwfES4dEC2BjPh9nfpMZpsvRmJgvdQsAAAAB3RSTlMAJa7x/2KtsvzMdQAAAMhJREFUeAF901OCxUAQQNFqxLa5/0VOZZ7a9/cETQAglHEtRglgHrfk4XvcGgFqRx+YHRlwR28MlEQMQiyKojiOkyRJ0yyQES3P87goijTLFERD+jfEUsKqRmuqCq3tur4XEJVHeTwEAf6vUwfEx+mDWfeIgnH8YJqZsUj+seytmJVGTIoUsSxnB87zYsL0wXleDbi9cdUR2/aN82BdDxOO4/jgcV4SCgWHjEzC8xSQgS/hdV33F30gXFJMOJquQ40R33QdfHzvD0JcFoxUz1djAAAAAElFTkSuQmCC'
  },
  'qoder-cli': {
    name: 'Qoder CLI',
    icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/qoder-color.svg'
  },
  'qoder-cli-cn': {
    name: 'Qoder CN CLI',
    icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/qoder-color.svg'
  },
  'dsh-acp': {
    name: 'DeepSeek Harness',
    icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/deepseek-color.svg'
  },
  openclaw: {
    name: 'OpenClaw',
    icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/openclaw-color.svg'
  }
}

function publicIconUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'cdn.agentclientprotocol.com' ? url.toString() : null
  } catch {
    return null
  }
}

export async function GET() {
  try {
    const upstream = await fetch(ACP_REGISTRY_URL, { next: { revalidate: 300 } })
    if (!upstream.ok) throw new Error(`ACP Registry returned ${upstream.status}`)

    const body = (await upstream.json()) as { agents?: RawRegistryEntry[] | Record<string, RawRegistryEntry> }
    const entries = Array.isArray(body.agents) ? body.agents : Object.values(body.agents ?? {})
    const agents = Object.fromEntries(
      entries.flatMap((entry) => {
        if (typeof entry.id !== 'string' || typeof entry.name !== 'string') return []
        const name = entry.name.trim()
        if (!name) return []
        return [[entry.id, { name, icon: publicIconUrl(entry.icon) }]]
      })
    )

    // Curated entries win for their ids — our reviewed marks for runtimes the
    // public registry doesn't carry.
    return Response.json(
      { agents: { ...agents, ...CURATED_AGENTS } },
      { headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' } }
    )
  } catch {
    // Curated marks are local, so still serve them when the upstream fetch fails.
    return Response.json({ agents: { ...CURATED_AGENTS } })
  }
}
