/**
 * The MCP endpoint's public identity: the resource URL the CP advertises (RFC 9728)
 * and the descriptor URL it hands daemons must be the SAME string, under both deploy
 * shapes. They diverged once — the descriptor pointed at the internal `/api/v1/mcp`
 * mount, which a two-origin deploy does not expose — and the only symptom was a
 * webchat session silently missing its entire `agentconnect-admin` server.
 */
import { describe, it, expect } from 'vitest'
import type { HttpServerConfig } from '../deps.js'
import { protectedResourceMetadata, webchatMcpDescriptorUrl } from './base.js'

type PublicUrlConfig = Pick<HttpServerConfig, 'PUBLIC_CP_URL' | 'PUBLIC_MCP_URL'>

describe('webchatMcpDescriptorUrl', () => {
  it('is the dedicated MCP origin when one is configured', () => {
    const config = { PUBLIC_CP_URL: 'https://api.example.test', PUBLIC_MCP_URL: 'https://mcp.example.test' }
    expect(webchatMcpDescriptorUrl(config)).toBe('https://mcp.example.test')
    expect(webchatMcpDescriptorUrl(config)).toBe(protectedResourceMetadata(config.PUBLIC_CP_URL, config).resource)
  })

  it('falls back to the PUBLIC /v1/mcp alias — never the internal /api/v1 mount', () => {
    const config: PublicUrlConfig = { PUBLIC_CP_URL: 'https://api.example.test/' }
    expect(webchatMcpDescriptorUrl(config)).toBe('https://api.example.test/v1/mcp')
    expect(webchatMcpDescriptorUrl(config)).not.toContain('/api/v1')
    expect(webchatMcpDescriptorUrl(config)).toBe(protectedResourceMetadata('https://api.example.test', config).resource)
  })

  it('addresses the local direct-hit CP when no public origin is configured', () => {
    expect(webchatMcpDescriptorUrl({})).toBe('http://localhost:8080/v1/mcp')
  })
})
