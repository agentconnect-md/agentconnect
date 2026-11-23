import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  probeMattermostBlocksSave,
  probeMattermostInstance,
  type MattermostProbeResult
} from '../src/mattermost-probe.js'

const INSTANCE = 'https://chat.example.test'

function okPing(seen: Array<{ url: string; init?: RequestInit }>, body: unknown = { status: 'OK' }): typeof fetch {
  return (async (input, init) => {
    seen.push({ url: String(input), init })
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
}

function throwing(error: unknown): typeof fetch {
  return (async () => {
    throw error
  }) as typeof fetch
}

function tlsFailure(code: string): Error {
  const inner = Object.assign(new Error('certificate verify failed'), { code })
  return Object.assign(new TypeError('fetch failed'), { cause: inner })
}

describe('probeMattermostInstance — unauthenticated Mattermost probe', () => {
  it('accepts a 200 Mattermost ping JSON response and preserves subpaths while stripping trailing slashes', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const probe = await probeMattermostInstance(
      ' HTTPS://Chat.Example.TEST/team/// ',
      okPing(seen, { ActiveSearchBackend: 'database', status: 'OK' })
    )

    expect(probe).toMatchObject({
      status: 'ok',
      serverUrl: 'https://chat.example.test/team'
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://chat.example.test/team/api/v4/system/ping')
    expect(seen[0]?.init?.method).toBe('GET')
    expect(seen[0]?.init?.redirect).toBe('manual')
    expect(seen[0]?.init?.headers).toEqual({ accept: 'application/json' })
  })

  it('accepts http://, RFC1918, loopback, and ULA intranet URLs as well as 401/403 JSON errors', async () => {
    for (const raw of [
      'http://10.0.12.5:8065/',
      'http://127.0.0.1:8065',
      'http://[::1]:8065/mm',
      'http://[fd12:3456::1]:8065'
    ]) {
      const seen: Array<{ url: string; init?: RequestInit }> = []
      const probe = await probeMattermostInstance(raw, okPing(seen, { ActiveSearchBackend: 'database' }))
      expect(probe.status, raw).toBe('ok')
      expect(seen).toHaveLength(1)
    }

    for (const status of [401, 403]) {
      const probe = await probeMattermostInstance(
        INSTANCE,
        (async () =>
          new Response(
            JSON.stringify({ id: 'api.context.session_expired.app_error', message: 'Denied', status_code: status }),
            {
              status,
              headers: { 'content-type': 'application/json' }
            }
          )) as typeof fetch
      )
      expect(probe, `status ${status}`).toMatchObject({ status: 'ok', serverUrl: INSTANCE })
    }
  })

  it('refuses invalid URLs, userinfo, queries, fragments, whitespace, and link-local/unspecified IPs without dialing', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    for (const raw of [
      '',
      '   ',
      'https://chat .example.test',
      'chat.example.test',
      'ftp://chat.example.test',
      'ws://chat.example.test',
      'https://user:pass@chat.example.test',
      'https://chat.example.test?token=1',
      'https://chat.example.test#frag',
      'http://169.254.169.254',
      'http://169.254.1.10:8065',
      'http://0.0.0.0:8065',
      'http://[::]:8065',
      'http://[fe80::1]:8065',
      'http://[fd00:ec2::254]/latest',
      'http://100.100.100.200/latest',
      'http://192.0.0.192/opc/v2',
      'http://[::ffff:169.254.169.254]',
      'http://[64:ff9b::169.254.169.254]',
      'http://[::ffff:0.0.0.0]'
    ]) {
      const probe = await probeMattermostInstance(raw, okPing(seen))
      expect(probe.status, raw).toBe('invalid_url')
      expect(probe.serverUrl, raw).toBeUndefined()
    }
    expect(seen).toEqual([])
  })

  it('rejects DNS resolutions to IMDS/link-local addresses and oversized ping payloads', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const blockedLookup = ((
      _host: string,
      _opts: unknown,
      cb: (e: null, a: Array<{ address: string; family: number }>) => void
    ) => cb(null, [{ address: '169.254.169.254', family: 4 }])) as unknown as typeof import('node:dns').lookup
    expect(await probeMattermostInstance(INSTANCE, okPing(seen), blockedLookup)).toMatchObject({
      status: 'invalid_url'
    })
    expect(seen).toEqual([])

    const oversized = (async () =>
      new Response(JSON.stringify({ status: 'OK', pad: 'x'.repeat(70_000) }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    expect(await probeMattermostInstance(INSTANCE, oversized)).toMatchObject({
      status: 'not_a_mattermost_api_root',
      serverUrl: INSTANCE
    })
  })

  it('distinguishes untrusted TLS chains (with NODE_EXTRA_CA_CERTS guidance) from unreachable hosts', async () => {
    const dns = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    })
    expect(await probeMattermostInstance(INSTANCE, throwing(dns))).toMatchObject({
      status: 'unreachable',
      serverUrl: INSTANCE
    })

    for (const code of [
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID'
    ]) {
      const probe = await probeMattermostInstance(INSTANCE, throwing(tlsFailure(code)))
      expect(probe, code).toMatchObject({ status: 'tls_untrusted', serverUrl: INSTANCE })
      expect(probe.message).toContain('NODE_EXTRA_CA_CERTS')
      expect(probe.message).toContain('Setup Server')
      expect(probe.message).toContain('Control Plane')
      expect(probe.message).toContain('Logto')
    }

    const aggregate = Object.assign(new AggregateError([tlsFailure('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')], 'failed'))
    expect(await probeMattermostInstance(INSTANCE, throwing(aggregate))).toMatchObject({
      status: 'tls_untrusted',
      serverUrl: INSTANCE
    })
  })

  it('reports non-Mattermost responses, redirects, non-JSON bodies, and unhealthy statuses as not_a_mattermost_api_root', async () => {
    const responder = (response: Response): typeof fetch => (async () => response) as typeof fetch
    const cases: Array<[Response, string]> = [
      [new Response('<html>hello</html>', { status: 200 }), '200 HTML'],
      [new Response('[]', { status: 200 }), '200 JSON array'],
      [new Response(JSON.stringify({ status: 'FAIL' }), { status: 200 }), '200 status FAIL'],
      [new Response(null, { status: 302, headers: { location: 'https://other.example.test' } }), '302 redirect'],
      [new Response('<html>sign in</html>', { status: 401 }), '401 HTML'],
      [new Response('<html>forbidden</html>', { status: 403 }), '403 HTML'],
      [new Response('not found', { status: 404 }), '404'],
      [new Response(JSON.stringify({ status: 'unhealthy' }), { status: 500 }), '500 unhealthy'],
      [new Response('bad gateway', { status: 502 }), '502']
    ]

    for (const [response, label] of cases) {
      const probe = await probeMattermostInstance(INSTANCE, responder(response))
      expect(probe.status, label).toBe('not_a_mattermost_api_root')
      expect(probe.serverUrl).toBe(INSTANCE)
    }
  })

  it('blocks saving only when the URL shape is invalid', () => {
    const of = (status: MattermostProbeResult['status']): MattermostProbeResult => ({ status, message: status })
    expect(probeMattermostBlocksSave(of('invalid_url'))).toBe(true)
    for (const status of ['ok', 'unreachable', 'tls_untrusted', 'not_a_mattermost_api_root'] as const) {
      expect(probeMattermostBlocksSave(of(status))).toBe(false)
    }
  })

  it('enforces DNS SSRF pinning even when fetchImpl is globalThis.fetch or omitted, and handles oversized, truncated, and slow-drip streams in nodePinnedProbeGet', async () => {
    for (const ip of ['169.254.169.254', 'fe80::1']) {
      const family = ip.includes(':') ? 6 : 4
      const blockedLookup = ((
        _host: string,
        _opts: unknown,
        cb: (e: null, a: Array<{ address: string; family: number }>) => void
      ) => cb(null, [{ address: ip, family }])) as unknown as typeof import('node:dns').lookup

      expect(await probeMattermostInstance(INSTANCE, undefined, blockedLookup)).toMatchObject({
        status: 'invalid_url'
      })
      expect(await probeMattermostInstance(INSTANCE, globalThis.fetch, blockedLookup)).toMatchObject({
        status: 'invalid_url'
      })
    }

    let mode: 'ok' | 'oversized' | 'truncate' | 'slow-drip' = 'ok'
    const server = createServer((_req, res) => {
      if (mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'OK' }))
        return
      }
      if (mode === 'oversized') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'OK', pad: 'x'.repeat(70_000) }))
        return
      }
      if (mode === 'truncate') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"status":')
        res.socket?.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{')
      const drip = setInterval(() => {
        if (res.destroyed || res.writableEnded) {
          clearInterval(drip)
          return
        }
        res.write(' ')
      }, 20)
      res.on('close', () => clearInterval(drip))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port
      const loopbackLookup = ((_host: string, opts: unknown, cb: (e: null, a: unknown, f?: number) => void) => {
        if ((opts as { all?: boolean } | undefined)?.all) {
          cb(null, [{ address: '127.0.0.1', family: 4 }])
        } else {
          cb(null, '127.0.0.1', 4)
        }
      }) as unknown as typeof import('node:dns').lookup
      const targetUrl = `http://mattermost.example.test:${port}`

      expect(await probeMattermostInstance(targetUrl, undefined, loopbackLookup)).toMatchObject({
        status: 'ok',
        serverUrl: targetUrl
      })

      mode = 'oversized'
      const oversizedRes = await probeMattermostInstance(targetUrl, undefined, loopbackLookup)
      expect(oversizedRes).toMatchObject({
        status: 'not_a_mattermost_api_root',
        serverUrl: targetUrl
      })
      expect(oversizedRes.message).toContain('larger than 65536 bytes')

      mode = 'truncate'
      expect(await probeMattermostInstance(targetUrl, undefined, loopbackLookup)).toMatchObject({
        status: 'unreachable',
        serverUrl: targetUrl
      })

      mode = 'slow-drip'
      expect(await probeMattermostInstance(targetUrl, undefined, loopbackLookup, { timeoutMs: 60 })).toMatchObject({
        status: 'unreachable',
        serverUrl: targetUrl
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
