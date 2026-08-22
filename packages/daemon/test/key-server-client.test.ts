import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { KeyServerClient, KeyServerError } from '../src/key-server/client.js'

const request = {
  orgId: 'org-a',
  agentId: 'agent-a',
  sessionId: 'session-a',
  provider: 'openai' as const,
  ttlSeconds: 3_600
}

describe('KeyServerClient', () => {
  it('issues a key with a freshly-read bearer and request-start deadlines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'key-server-client-'))
    const tokenPath = join(dir, 'token')
    writeFileSync(tokenPath, 'first\n')
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            keyId: 'key-1',
            key: 'secret',
            baseUrl: 'https://gateway.example/v1',
            expiresInSeconds: 1_800,
            refreshInSeconds: 900
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const client = new KeyServerClient('https://keys.example/root/', { tokenPath, fetch, now: () => 10_000 })

    const grant = await client.issue(request)
    expect(grant).toMatchObject({
      keyId: 'key-1',
      requestedAtMs: 10_000,
      refreshAtMs: 910_000,
      expiresAtMs: 1_810_000
    })
    // The issuer above still sends the retired `baseUrl`; the grant must not carry it.
    expect('baseUrl' in grant).toBe(false)
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://keys.example/v1/issue-key'),
      expect.objectContaining({
        headers: { authorization: 'Bearer first', 'content-type': 'application/json' },
        body: JSON.stringify(request)
      })
    )

    writeFileSync(tokenPath, 'second\n')
    await client.issue(request)
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: 'Bearer second',
      'content-type': 'application/json'
    })
  })

  it('rejects an overlong or malformed grant', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ keyId: 'key-1', key: 'secret', expiresInSeconds: 7_200 }), { status: 200 })
      )
    const client = new KeyServerClient('https://keys.example', { fetch })
    await expect(client.issue(request)).rejects.toMatchObject({ code: 'unavailable' } satisfies Partial<KeyServerError>)
  })

  it('surfaces machine-readable denials and revokes by issuance id', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'quota_denied', message: 'budget exhausted' } }), {
          status: 403
        })
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const client = new KeyServerClient('https://keys.example', { fetch })
    await expect(client.issue(request)).rejects.toMatchObject({
      code: 'quota_denied',
      message: 'budget exhausted',
      status: 403
    } satisfies Partial<KeyServerError>)
    await expect(client.revoke('key-1')).resolves.toBeUndefined()
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ keyId: 'key-1' }))
  })

  it("takes either scheme — that is the deployment's call — and rejects credentials in the address", () => {
    // http is not a downgrade this client gets to veto: the bearer is a projected ServiceAccount
    // token, and the same process already carries one over an in-cluster `ws://` socket to the CP.
    expect(() => new KeyServerClient('http://keys.example')).not.toThrow()
    expect(() => new KeyServerClient('https://keys.example')).not.toThrow()
    expect(() => new KeyServerClient('ftp://keys.example')).toThrow(/http or https/)
    expect(() => new KeyServerClient('https://user:pass@keys.example')).toThrow(/must not contain credentials/)
  })

  it('classifies an unreadable token file as key-server authentication failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = new KeyServerClient('https://keys.example', { tokenPath: '/definitely/missing/token', fetch })
    await expect(client.issue(request)).rejects.toMatchObject({
      code: 'unauthorized'
    } satisfies Partial<KeyServerError>)
    expect(fetch).not.toHaveBeenCalled()
  })
})
