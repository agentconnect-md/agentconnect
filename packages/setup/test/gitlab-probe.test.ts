import { describe, expect, it } from 'vitest'
import { probeBlocksSave, probeGitlabInstance, type GitlabProbeResult } from '../src/gitlab-probe.js'

const INSTANCE = 'https://gitlab.example.test'

/** A healthy GitLab API root refuses an unauthenticated read with its own JSON. */
function apiRoot(seen: string[]): typeof fetch {
  return (async (input) => {
    seen.push(String(input))
    return new Response(JSON.stringify({ message: '401 Unauthorized' }), {
      status: 401,
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

describe('the Setup Server instance probe (§24.2)', () => {
  it('accepts a GitLab API root, addressing the normalized base', async () => {
    const seen: string[] = []
    const probe = await probeGitlabInstance(`${INSTANCE}/gitlab/`, apiRoot(seen))

    expect(probe).toMatchObject({ status: 'ok', baseUrl: `${INSTANCE}/gitlab` })
    // Concatenation onto the normalized base: a path prefix must survive.
    expect(seen).toEqual([`${INSTANCE}/gitlab/api/v4/version`])
  })

  it('refuses the URL shapes the axis does not accept, without dialling anything', async () => {
    const seen: string[] = []
    for (const raw of [
      'http://gitlab.example.test',
      'https://user:pass@gitlab.example.test',
      'https://gitlab.example.test?token=1',
      'https://gitlab.example.test#fragment',
      'gitlab.example.test'
    ]) {
      expect(await probeGitlabInstance(raw, apiRoot(seen))).toMatchObject({ status: 'invalid_url' })
    }
    expect(seen).toEqual([])
  })

  it('reports an unreachable instance and an untrusted chain apart', async () => {
    const dns = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    })
    expect(await probeGitlabInstance(INSTANCE, throwing(dns))).toMatchObject({
      status: 'unreachable',
      baseUrl: INSTANCE
    })
    for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED']) {
      expect(await probeGitlabInstance(INSTANCE, throwing(tlsFailure(code)))).toMatchObject({
        status: 'tls_untrusted',
        baseUrl: INSTANCE
      })
    }
  })

  it('reports anything that answers but not as a GitLab API root', async () => {
    const responder = (response: Response): typeof fetch => (async () => response) as typeof fetch
    const cases: Array<[Response, string]> = [
      [new Response('<html>hello</html>', { status: 200 }), '200'],
      [new Response('not found', { status: 404 }), '404'],
      [new Response('<html>sign in</html>', { status: 401 }), '401 without a JSON body'],
      [new Response('bad gateway', { status: 502 }), '502']
    ]
    for (const [response, label] of cases) {
      const probe = await probeGitlabInstance(INSTANCE, responder(response))
      expect(probe.status, label).toBe('not_a_gitlab_api_root')
      expect(probe.baseUrl).toBe(INSTANCE)
    }
  })

  it('blocks the save on shape alone', () => {
    const of = (status: GitlabProbeResult['status']): GitlabProbeResult => ({ status, message: status })
    expect(probeBlocksSave(of('invalid_url'))).toBe(true)
    // The Setup Server and the Control Plane need not share a network position,
    // so none of these is this process's verdict to make.
    for (const status of ['unreachable', 'tls_untrusted', 'not_a_gitlab_api_root', 'ok'] as const) {
      expect(probeBlocksSave(of(status))).toBe(false)
    }
  })
})
