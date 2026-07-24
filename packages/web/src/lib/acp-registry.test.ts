import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/acp-registry/route'
import { acpRuntime } from './acp-registry'
import { runtimeLabel } from './data'

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
    expect(await response.json()).toEqual({
      agents: {
        'claude-acp': {
          name: 'Claude Agent',
          icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg'
        },
        custom: { name: 'Custom', icon: null }
      }
    })
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
