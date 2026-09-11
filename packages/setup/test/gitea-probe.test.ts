/**
 * The Gitea instance probe (gitea-integration.md §3). Unlike GitLab's, `GET /api/v1/version` needs
 * no credentials, so the VERSION FLOOR is checked when the address is saved — and the floor, like
 * the URL shape, blocks the save. Everything else warns.
 */
import { describe, expect, it } from 'vitest'
import { parseGiteaVersion, probeBlocksSave, probeGiteaInstance } from '../src/gitea-probe.js'

const INSTANCE = 'https://gitea.example.test'

/** A Gitea API root answers the version unauthenticated. */
function apiRoot(version: string, seen: string[] = []): typeof fetch {
  return (async (input) => {
    seen.push(String(input))
    return new Response(JSON.stringify({ version }), {
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

/** How `fetch` reports a TLS verification failure: the code is on a nested cause. */
function tlsFailure(code: string): Error {
  const inner = Object.assign(new Error('certificate verify failed'), { code })
  return Object.assign(new TypeError('fetch failed'), { cause: inner })
}

describe('the Gitea instance probe (§3)', () => {
  it('accepts an instance at or above the floor, addressing the normalized base', async () => {
    const seen: string[] = []
    const probe = await probeGiteaInstance(`${INSTANCE}/gitea/`, apiRoot('1.23.1', seen))

    expect(probe).toMatchObject({ status: 'ok', baseUrl: `${INSTANCE}/gitea`, version: '1.23.1' })
    expect(probeBlocksSave(probe)).toBe(false)
    // Concatenation onto the normalized base: a path prefix must survive.
    expect(seen).toEqual([`${INSTANCE}/gitea/api/v1/version`])
  })

  it('accepts the development build the probes ran against', async () => {
    expect(await probeGiteaInstance(INSTANCE, apiRoot('1.27.0+dev'))).toMatchObject({ status: 'ok' })
  })

  it('refuses the URL shapes the axis does not accept, without dialling anything', async () => {
    const seen: string[] = []
    for (const raw of [
      'http://gitea.example.test',
      'https://user:pass@gitea.example.test',
      'https://gitea.example.test?token=1',
      'https://gitea.example.test#fragment',
      'gitea.example.test'
    ]) {
      const probe = await probeGiteaInstance(raw, apiRoot('1.23.1', seen))
      expect(probe, raw).toMatchObject({ status: 'invalid_url' })
      expect(probeBlocksSave(probe)).toBe(true)
    }
    expect(seen).toEqual([])
  })

  it('refuses an instance below the floor, and a Forgejo build with it', async () => {
    for (const version of ['1.22.6', '1.18.0', '0.9.0', '11.0.1+gitea-1.22.0']) {
      const probe = await probeGiteaInstance(INSTANCE, apiRoot(version))
      expect(probe, version).toMatchObject({ status: 'instance_version_unsupported', version })
      expect(probeBlocksSave(probe)).toBe(true)
    }
  })

  it('fails closed on a version it cannot read', async () => {
    for (const version of ['unknown', 'v', '+gitea']) {
      expect(await probeGiteaInstance(INSTANCE, apiRoot(version)), version).toMatchObject({
        status: 'instance_version_unsupported'
      })
    }
    // A body with no version string at all is not an API root, which WARNS rather than blocking.
    const noBody = (async () => new Response('{}', { status: 200 })) as typeof fetch
    const probe = await probeGiteaInstance(INSTANCE, noBody)
    expect(probe.status).toBe('not_a_gitea_api_root')
    expect(probeBlocksSave(probe)).toBe(false)
  })

  it('warns rather than blocks on an unreachable instance, an untrusted chain, or another service', async () => {
    const dns = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    })
    const unreachable = await probeGiteaInstance(INSTANCE, throwing(dns))
    expect(unreachable).toMatchObject({ status: 'unreachable', baseUrl: INSTANCE })
    expect(probeBlocksSave(unreachable)).toBe(false)

    const untrusted = await probeGiteaInstance(INSTANCE, throwing(tlsFailure('SELF_SIGNED_CERT_IN_CHAIN')))
    expect(untrusted).toMatchObject({ status: 'tls_untrusted', baseUrl: INSTANCE })
    expect(probeBlocksSave(untrusted)).toBe(false)

    const html = (async () => new Response('<html></html>', { status: 404 })) as typeof fetch
    expect(await probeGiteaInstance(INSTANCE, html)).toMatchObject({ status: 'not_a_gitea_api_root' })
  })

  it('reads the gitea-compatibility marker in preference to a fork version', () => {
    expect(parseGiteaVersion('1.23.1')).toEqual({ major: 1, minor: 23 })
    expect(parseGiteaVersion('v1.27.0+dev')).toEqual({ major: 1, minor: 27 })
    expect(parseGiteaVersion('11.0.1+gitea-1.22.0')).toEqual({ major: 1, minor: 22 })
    expect(parseGiteaVersion('nope')).toBeUndefined()
    expect(parseGiteaVersion(undefined)).toBeUndefined()
  })
})
