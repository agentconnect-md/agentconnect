import { describe, it, expect } from 'vitest'
import { McpServerSpec, RcMcpAssign } from '@agentconnect.md/protocol'
import {
  mintGrantKey,
  grantKeyHash,
  currentMcpGrant,
  mcpProxyDef,
  mcpRcAssign,
  blockedUpstreamUrl,
  relayHttpOrigin
} from './mcpProvider.js'

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
