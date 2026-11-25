import { describe, it, expect } from 'vitest'
import { McpServerSpec, RcMcpAssign } from '@agentconnect.md/protocol'
import {
  mintGrantKey,
  grantKeyHash,
  currentMcpGrant,
  mcpProxyDef,
  mcpRcAssign,
  mcpRcAssignFor,
  mcpBinding,
  mcpAgentDef,
  blockedUpstreamUrl,
  relayHttpOrigin
} from './mcpProvider.js'
import { relayToolPolicy } from './mcpToolPolicy.js'

const provider = {
  id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  orgId: '11111111-1111-4111-8111-111111111111',
  name: 'linear',
  url: 'https://mcp.linear.app/sse'
}

describe('mintGrantKey', () => {
  it('has the oct_ prefix and base64url body', () => {
    const k = mintGrantKey()
    expect(k).toMatch(/^oct_[A-Za-z0-9_-]+$/)
  })
  it('is effectively unique across mints', () => {
    const n = 1000
    const set = new Set(Array.from({ length: n }, mintGrantKey))
    expect(set.size).toBe(n)
  })
})

describe('relayHttpOrigin', () => {
  it('normalizes the relay rd/* WS url to an HTTP(S) origin and drops the path', () => {
    expect(relayHttpOrigin('wss://relay-0.example:8443/api/v1/relays/ws')).toBe('https://relay-0.example:8443')
    expect(relayHttpOrigin('ws://localhost:8080/rd')).toBe('http://localhost:8080')
    expect(relayHttpOrigin('https://relay.example')).toBe('https://relay.example')
  })

  it('produces an http-scheme proxy url when fed a wss relay (the transport bug)', () => {
    const def = mcpProxyDef(
      provider,
      { key: 'oct_k', createdAt: new Date(0) },
      relayHttpOrigin('wss://relay.example/rd')
    )
    expect(def.url).toBe('https://relay.example/mcp/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')
    expect(def.transport).toBe('http')
  })
})

describe('grantKeyHash', () => {
  it('is deterministic and 64 hex chars (sha256)', () => {
    expect(grantKeyHash('oct_abc')).toBe(grantKeyHash('oct_abc'))
    expect(grantKeyHash('oct_abc')).toMatch(/^[0-9a-f]{64}$/)
  })
  it('differs for different keys', () => {
    expect(grantKeyHash('oct_a')).not.toBe(grantKeyHash('oct_b'))
  })
})

describe('currentMcpGrant', () => {
  const at = (ms: number, key: string) => ({ key, createdAt: new Date(ms) })

  it('picks the NEWEST active grant — the retiring one is first during a rotation', () => {
    // `activeForProvider` orders by createdAt ascending, and rotation deliberately
    // leaves both active until the fresh key is distributed. Taking the head inside
    // that window projects the key the CP is about to revoke.
    expect(currentMcpGrant([at(1_000, 'oct_retiring'), at(2_000, 'oct_fresh')])?.key).toBe('oct_fresh')
  })
  it('is undefined when there is no active grant at all', () => {
    expect(currentMcpGrant([])).toBeUndefined()
  })
})

describe('mcpProxyDef', () => {
  const def = mcpProxyDef(
    provider,
    { key: 'oct_secret', createdAt: new Date(1_700_000_000_000) },
    'https://relay.example.com'
  )

  it('carries the daemon-hosting flag only when the provider sets it', () => {
    const grant = { key: 'oct_secret', createdAt: new Date(1_700_000_000_000) }
    const hosted = mcpProxyDef({ ...provider, ui: true }, grant, 'https://relay.example.com')
    expect(hosted.ui).toBe(true)
    expect(() => McpServerSpec.parse(hosted)).not.toThrow()
    // Absent rather than `false` on an ordinary provider: its definition stays byte-identical to
    // what it was before the flag existed, so nothing downstream re-orders or re-versions.
    expect('ui' in def).toBe(false)
    expect(McpServerSpec.parse(def).ui).toBeUndefined()
  })

  it('orders itself by the instant its grant was issued', () => {
    expect(def.issuedAt).toBe(1_700_000_000_000)
  })

  it('is a valid McpServerSpec', () => {
    expect(() => McpServerSpec.parse(def)).not.toThrow()
  })
  it('points at the relay proxy URL, not upstream', () => {
    expect(def.url).toBe('https://relay.example.com/mcp/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')
    expect(def.transport).toBe('http')
    expect(def.name).toBe('linear')
  })
  it('carries the grant key as a Bearer header — never the upstream url/secret', () => {
    expect(def.headers).toEqual([{ name: 'Authorization', value: 'Bearer oct_secret' }])
    const blob = JSON.stringify(def)
    expect(blob).not.toContain(provider.url)
  })
})

describe('blockedUpstreamUrl (SSRF fast-fail)', () => {
  it('allows a public https url', () => {
    expect(blockedUpstreamUrl('https://mcp.linear.app/sse')).toBeNull()
    expect(blockedUpstreamUrl('http://example.com:8080/mcp')).toBeNull()
    expect(blockedUpstreamUrl('https://[2606:4700:4700::1111]/mcp')).toBeNull() // public IPv6
  })
  it('rejects a non-http(s) scheme and a malformed url', () => {
    expect(blockedUpstreamUrl('ftp://example.com')).not.toBeNull()
    expect(blockedUpstreamUrl('file:///etc/passwd')).not.toBeNull()
    expect(blockedUpstreamUrl('not a url')).not.toBeNull()
  })
  it('rejects loopback / private / link-local / metadata hosts', () => {
    for (const u of [
      'http://localhost/mcp',
      'http://127.0.0.1/mcp',
      'http://10.1.2.3/mcp',
      'http://172.16.0.1/mcp',
      'http://192.168.1.1/mcp',
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'http://[::1]/mcp',
      'http://[fd00::1]/mcp', // ULA
      'http://[fe80::1]/mcp', // link-local
      'http://[::ffff:127.0.0.1]/mcp' // IPv4-mapped loopback
    ]) {
      expect(blockedUpstreamUrl(u), u).not.toBeNull()
    }
  })
})

describe('mcpRcAssign', () => {
  const upstream = [{ name: 'Authorization', value: 'Bearer UPSTREAM_SECRET' }]
  const keys = ['oct_one', 'oct_two']
  const assign = mcpRcAssign(provider, upstream, keys)

  it('is a valid RcMcpAssign', () => {
    expect(() => RcMcpAssign.parse(assign)).not.toThrow()
  })
  it('ships upstream url + secret headers and HASHES the grant keys', () => {
    expect(assign.providerId).toBe(provider.id)
    expect(assign.upstreamUrl).toBe(provider.url)
    expect(assign.headers).toEqual(upstream)
    expect(assign.grantKeyHashes).toEqual([grantKeyHash('oct_one'), grantKeyHash('oct_two')])
    // plaintext grant keys never appear in the relay frame
    const blob = JSON.stringify(assign)
    expect(blob).not.toContain('oct_one')
    expect(blob).not.toContain('oct_two')
  })
})

describe('mcpRcAssignFor — one binding shaped per relay (mcp-tool-permissions.md §6.1, §8)', () => {
  const upstream = [{ name: 'Authorization', value: 'Bearer UPSTREAM_SECRET' }]
  const readOnly = { allow: ['read'], approval: [], ask: [] }
  const binding = mcpBinding(
    provider,
    upstream,
    ['oct_shared'],
    [
      { key: 'oct_agent_a', policy: readOnly },
      { key: 'oct_agent_b', policy: { allow: ['read'], approval: [], ask: [] } },
      { key: 'oct_agent_c', policy: { allow: ['read', 'write'], approval: [], ask: [] } }
    ]
  )

  it('gives a relay advertising mcp-tool-policy-v1 the restricted grants over deduplicated tables', () => {
    const assign = mcpRcAssignFor(binding, ['mcp-tool-policy-v1'])
    expect(() => RcMcpAssign.parse(assign)).not.toThrow()
    expect(assign.grantKeyHashes).toEqual([grantKeyHash('oct_shared')])
    expect(assign.toolPolicies).toEqual([readOnly, { allow: ['read', 'write'], approval: [], ask: [] }])
    expect(assign.restrictedGrants).toEqual([
      { grantKeyHash: grantKeyHash('oct_agent_a'), policy: 0 },
      { grantKeyHash: grantKeyHash('oct_agent_b'), policy: 0 },
      { grantKeyHash: grantKeyHash('oct_agent_c'), policy: 1 }
    ])
    expect(JSON.stringify(assign)).not.toContain('oct_agent')
  })

  it('gives a relay without it no restricted grant at all, so their calls are refused there', () => {
    for (const features of [undefined, [], ['hook-decision-routing-v1']]) {
      const assign = mcpRcAssignFor(binding, features)
      expect(assign).toEqual(mcpRcAssign(provider, upstream, ['oct_shared']))
      expect(assign).not.toHaveProperty('restrictedGrants')
    }
  })

  it('sends a daemon grant’s approval-gated names only to a relay that also handles approvals; a runtime grant never has them', () => {
    const table = { allowTools: ['read'], approvalTools: ['write'], askTools: ['delete'] }
    const custody = mcpBinding(
      provider,
      upstream,
      ['oct_shared'],
      [
        { key: 'oct_daemon', policy: relayToolPolicy(table, 'daemon') },
        { key: 'oct_runtime', policy: relayToolPolicy(table, 'runtime') }
      ]
    )
    const blank = { allow: ['read'], approval: [], ask: [] }
    const capable = mcpRcAssignFor(custody, ['mcp-tool-policy-v1', 'mcp-tool-approval-v1'])
    expect(capable.toolPolicies).toEqual([{ allow: ['read'], approval: ['write'], ask: ['delete'] }, blank])
    expect(capable.restrictedGrants).toEqual([
      { grantKeyHash: grantKeyHash('oct_daemon'), policy: 0 },
      { grantKeyHash: grantKeyHash('oct_runtime'), policy: 1 }
    ])
    const older = mcpRcAssignFor(custody, ['mcp-tool-policy-v1'])
    expect(older.toolPolicies).toEqual([blank])
    expect(older.restrictedGrants).toEqual([
      { grantKeyHash: grantKeyHash('oct_daemon'), policy: 0 },
      { grantKeyHash: grantKeyHash('oct_runtime'), policy: 0 }
    ])
  })

  it('sends the unrestricted frame unchanged when there is no restricted grant', () => {
    expect(mcpRcAssignFor(mcpBinding(provider, upstream, ['oct_shared']), ['mcp-tool-policy-v1'])).toEqual(
      mcpRcAssign(provider, upstream, ['oct_shared'])
    )
  })
})

describe('mcpAgentDef', () => {
  it('layers the agent’s own grant and decision table over the shared definition’s shape', () => {
    const def = mcpAgentDef(
      provider,
      { key: 'oct_agent', createdAt: new Date(5_000), custody: 'runtime' },
      'https://relay.example.test',
      'agent-1',
      { allowTools: ['read'], approvalTools: ['write'], askTools: [] },
      [{ name: 'read' }, { name: 'write' }]
    )
    expect(() => McpServerSpec.parse(def)).not.toThrow()
    expect(def).toMatchObject({
      name: 'linear',
      agentId: 'agent-1',
      issuedAt: 5_000,
      url: `https://relay.example.test/mcp/${provider.id}`,
      headers: [{ name: 'Authorization', value: 'Bearer oct_agent' }],
      toolDecisions: { allow: ['read'], approval: [], ask: [], block: ['write'] }
    })
  })
})
