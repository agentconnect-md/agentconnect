import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/acp-registry/route'
import { acpRuntime } from './acp-registry'
import { FALLBACK_RUNTIME_IDS, runtimeLabel } from './data'

describe('ACP Registry metadata', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('normalizes the public registry to names and direct ACP CDN icon URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          agents: [
            {
              id: 'claude-acp',
              name: 'Claude Agent',
              icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg'
            },
            { id: 'custom', name: 'Custom', icon: 'https://untrusted.example/icon.svg' }
          ]
        })
      )
    )

    const response = await GET()
    expect(response.status).toBe(200)
    const { agents } = (await response.json()) as { agents: Record<string, { name: string; icon: string | null }> }
    // Upstream icons keep only the direct ACP CDN url; others are dropped to null.
    expect(agents['claude-acp']).toEqual({
      name: 'Claude Agent',
      icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg'
    })
    expect(agents.custom).toEqual({ name: 'Custom', icon: null })
    // Curated marks are merged in and bypass the CDN filter (our own trusted urls).
    expect(agents['kiro-cli']).toEqual({
      name: 'Kiro CLI',
      icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/kiro-color.svg'
    })
    expect(agents.openclaw).toEqual({
      name: 'OpenClaw',
      icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/openclaw-color.svg'
    })
  })

  it('serves curated marks even when the upstream registry fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    )
    const response = await GET()
    expect(response.status).toBe(200)
    const { agents } = (await response.json()) as { agents: Record<string, unknown> }
    expect(agents['kiro-cli']).toBeDefined()
  })

  // The alias table above is DISPLAY-only: it gives `claude`/`codex` a name and a mark, and
  // nothing rewrites them on the way to a daemon. So the ids the picker offers when a daemon
  // reports no profiles must be the registry's own — a bare `claude` looked right in the menu
  // and then failed activation with `runtime "claude" is unavailable`.
  it('offers only real registry ids as the no-profile fallback, never a display alias', () => {
    const registry = {
      'claude-acp': { name: 'Claude Agent', icon: null },
      'codex-acp': { name: 'Codex', icon: null },
      opencode: { name: 'OpenCode', icon: null }
    }
    for (const id of FALLBACK_RUNTIME_IDS) expect(registry[id as keyof typeof registry]).toBeDefined()
  })

  it('resolves legacy runtime ids and applies the product-name exception', () => {
    const registry = {
      'claude-acp': { name: 'Claude Agent', icon: 'https://cdn.agentclientprotocol.com/claude.svg' }
    }
    const claude = acpRuntime(registry, 'claude')
    expect(claude?.name).toBe('Claude Agent')
    expect(runtimeLabel('claude-acp', claude?.name)).toBe('Claude Code')
  })
})
