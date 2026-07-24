const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

interface RawRegistryEntry {
  id?: unknown
  name?: unknown
  icon?: unknown
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

    return Response.json(
      { agents },
      { headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' } }
    )
  } catch {
    return Response.json({ agents: {} }, { status: 502 })
  }
}
