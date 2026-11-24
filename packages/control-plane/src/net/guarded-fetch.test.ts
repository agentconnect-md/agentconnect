import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { lookup as dnsLookup, LookupAddress } from 'node:dns'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'
import {
  isBlockedAddress,
  isLinkLocalOrUnspecifiedAddress,
  guardedRequest,
  hostAllowlisted,
  makeGuardedLookup
} from './guarded-fetch.js'

// Resolves every name to `address` without touching DNS, so the guard's reject-if-any and
// pinning behavior can be exercised against a loopback server.
function fakeLookupFactory(address: string): (allowPrivate: boolean) => LookupFunction {
  return (allowPrivate) => {
    const fn: LookupFunction = (_hostname, options, callback) => {
      if (!allowPrivate && isBlockedAddress(address)) {
        return callback(new Error('ssrf: blocked address'), '', 0)
      }
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: Error | null, a: Array<{ address: string; family: number }>) => void)(null, [
          { address, family: 4 }
        ])
      }
      callback(null, address, 4)
    }
    return fn
  }
}

function staticResolve(addresses: LookupAddress[]): typeof dnsLookup {
  return ((
    _hostname: string,
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, resolved: LookupAddress[]) => void
  ) => {
    callback(null, addresses)
  }) as typeof dnsLookup
}

function fakeEndpoint(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/huge') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ pad: 'x'.repeat(4096) }))
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
      res.end()
      return
    }
    if (req.url === '/text') {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test/.well-known"' })
      res.end('not json')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method, echoed: body }))
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) })
    })
  })
}

describe('isBlockedAddress — CP outbound address classification', () => {
  it('blocks IPv4 loopback, private, CGNAT, link-local (incl. cloud metadata), and reserved', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '169.254.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '192.0.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255'
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })

  it('blocks IPv6 loopback, unspecified, ULA, link-local, IPv4-mapped, and bracketed literals', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::1]'
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it('allows public IPv6 and IPv4-mapped public', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })

  it('classifies link-local, IMDS, multicast, NAT64, translated-v6, and unspecified addresses under isLinkLocalOrUnspecifiedAddress', () => {
    for (const blocked of [
      '169.254.169.254',
      '169.254.0.1',
      '100.100.100.200',
      '192.0.0.192',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '0.0.0.0',
      'fe80::1',
      'febf::1',
      'ff02::1',
      'fd00:ec2::254',
      '::',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '::ffff:0:a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '64:ff9b:1::100.100.100.200',
      '::ffff:0.0.0.0'
    ]) {
      expect(isLinkLocalOrUnspecifiedAddress(blocked), blocked).toBe(true)
    }
    for (const allowed of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '::1', 'fc00::1', '8.8.8.8']) {
      expect(isLinkLocalOrUnspecifiedAddress(allowed), allowed).toBe(false)
    }
  })
})

describe('guardedRequest', () => {
  let endpoint: Awaited<ReturnType<typeof fakeEndpoint>>
  beforeAll(async () => {
    endpoint = await fakeEndpoint()
  })
  afterAll(async () => {
    await endpoint.close()
  })

  it.each([
    ['not a url', 'url_rejected'],
    ['ftp://mcp.example.test/mcp', 'url_rejected'],
    ['https://user:secret@mcp.example.test/mcp', 'url_rejected'],
    ['http://169.254.169.254/latest/meta-data', 'address_blocked'],
    ['http://[::1]:9/mcp', 'address_blocked']
  ])('refuses %s before dialing', async (url, failure) => {
    const result = await guardedRequest(url)
    expect(result).toEqual({ ok: false, failure })
  })

  it('refuses a public name that resolves to a blocked address', async () => {
    const result = await guardedRequest('https://mcp.example.test/mcp', {}, fakeLookupFactory('169.254.169.254'))
    expect(result).toEqual({ ok: false, failure: 'address_blocked' })
  })

  it('supports custom blockAddress overrides in guardedRequest', async () => {
    const result = await guardedRequest(
      'https://mm.example.test/api/v4/users/me',
      { blockAddress: isLinkLocalOrUnspecifiedAddress },
      (allowPrivate, blockAddress = isBlockedAddress) =>
        (_hostname, options, callback) => {
          if (!allowPrivate && blockAddress('169.254.169.254')) {
            return callback(new Error('ssrf: blocked address'), '', 0)
          }
          if ((options as { all?: boolean }).all) {
            return (callback as unknown as (e: Error | null, a: Array<{ address: string; family: number }>) => void)(
              null,
              [{ address: '169.254.169.254', family: 4 }]
            )
          }
          callback(null, '169.254.169.254', 4)
        }
    )
    expect(result).toEqual({ ok: false, failure: 'address_blocked' })
  })

  it('sends method, headers and body once the host is permitted', async () => {
    const result = await guardedRequest(`${endpoint.url}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"grant_type":"refresh_token"}',
      allowlist: new Set(['127.0.0.1'])
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.status).toBe(200)
    expect(result.response.json).toEqual({ method: 'POST', echoed: '{"grant_type":"refresh_token"}' })
  })

  it('holds a host:port allowlist entry to that port, while a bare host covers every port', async () => {
    const port = new URL(endpoint.url).port
    const onPort = await guardedRequest(`${endpoint.url}/text`, { allowlist: new Set([`127.0.0.1:${port}`]) })
    expect(onPort.ok).toBe(true)
    const otherPort = await guardedRequest(`${endpoint.url}/text`, { allowlist: new Set(['127.0.0.1:1']) })
    expect(otherPort).toEqual({ ok: false, failure: 'address_blocked' })
    expect(hostAllowlisted(new Set(['[fd00::7]:8443']), new URL('https://[fd00::7]:8443/x'))).toBe(true)
    expect(hostAllowlisted(new Set(['[fd00::7]:8443']), new URL('https://[fd00::7]/x'))).toBe(false)
    expect(hostAllowlisted(new Set(['chat.corp.example:443']), new URL('https://Chat.Corp.Example/x'))).toBe(true)
    expect(hostAllowlisted(new Set(['chat.corp.example']), new URL('http://chat.corp.example:8065/x'))).toBe(true)
  })

  it('hands a 3xx back as a response instead of following it past the pin', async () => {
    const result = await guardedRequest(`${endpoint.url}/redirect`, { allowlist: new Set(['127.0.0.1']) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.status).toBe(302)
  })

  it('keeps a non-JSON body readable, with its headers — a 401 challenge is the point', async () => {
    const result = await guardedRequest(`${endpoint.url}/text`, { allowlist: new Set(['127.0.0.1']) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.status).toBe(401)
    expect(result.response.json).toBeUndefined()
    expect(result.response.text).toBe('not json')
    expect(result.response.headers['www-authenticate']).toContain('resource_metadata=')
  })

  it('refuses a response larger than maxBytes', async () => {
    const result = await guardedRequest(`${endpoint.url}/huge`, { allowlist: new Set(['127.0.0.1']), maxBytes: 128 })
    expect(result).toEqual({ ok: false, failure: 'malformed_response' })
  })

  it('reports an unreachable host without revealing it', async () => {
    // Port 9 (discard) on an allowlisted loopback: connect is refused, not blocked.
    const result = await guardedRequest('http://127.0.0.1:9/mcp', {
      allowlist: new Set(['127.0.0.1']),
      timeoutMs: 2_000
    })
    expect(result).toEqual({ ok: false, failure: 'unreachable' })
  })

  it('supports dual-stack Happy Eyeballs fallback when IPv6 refuses and IPv4 listens', async () => {
    const port = new URL(endpoint.url).port
    const result = await guardedRequest(
      `http://localhost:${port}/api/v4/users/me`,
      { blockAddress: isLinkLocalOrUnspecifiedAddress },
      (allowPrivate, blockAddress) =>
        makeGuardedLookup(
          allowPrivate,
          blockAddress,
          staticResolve([
            { address: '::1', family: 6 },
            { address: '127.0.0.1', family: 4 }
          ])
        )
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.status).toBe(200)
  })

  it('refuses mixed resolutions when any returned address fails blockAddress', async () => {
    const result = await guardedRequest(
      'http://mm.example.test/api/v4/users/me',
      { blockAddress: isLinkLocalOrUnspecifiedAddress },
      (allowPrivate, blockAddress) =>
        makeGuardedLookup(
          allowPrivate,
          blockAddress,
          staticResolve([
            { address: '127.0.0.1', family: 4 },
            { address: '169.254.169.254', family: 4 }
          ])
        )
    )
    expect(result).toEqual({ ok: false, failure: 'address_blocked' })
  })

  it('refuses IMDS/link-local addresses even when the hostname is allowlisted', async () => {
    expect(
      await guardedRequest('http://169.254.169.254/latest/meta-data', { allowlist: new Set(['169.254.169.254']) })
    ).toEqual({ ok: false, failure: 'address_blocked' })
    expect(
      await guardedRequest(
        'http://internal.example.test/api/v4/users/me',
        { allowlist: new Set(['internal.example.test']) },
        (allowPrivate, blockAddress) =>
          makeGuardedLookup(allowPrivate, blockAddress, staticResolve([{ address: 'fd00:ec2::254', family: 6 }]))
      )
    ).toEqual({ ok: false, failure: 'address_blocked' })
  })

  it('aborts an in-flight or pre-aborted request cleanly when signal aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const preAborted = await guardedRequest(`${endpoint.url}/text`, {
      allowlist: new Set(['127.0.0.1']),
      signal: controller.signal
    })
    expect(preAborted).toEqual({ ok: false, failure: 'unreachable' })
  })

  it('exposes the real lookup factory as the default guard', () => {
    expect(typeof makeGuardedLookup(false)).toBe('function')
  })
})
