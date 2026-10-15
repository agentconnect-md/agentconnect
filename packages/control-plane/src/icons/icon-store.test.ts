import { describe, it, expect } from 'vitest'
import { sha256Hex, signHeaders } from '@agentconnect.md/object-store'
import { createIconStore, type IconStoreConfig } from './icon-store.js'

const CFG: IconStoreConfig = {
  endpoint: 'https://objects.example.test',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'example-secret-key',
  bucket: 'icons',
  region: 'auto',
  publicBaseUrl: 'https://cdn.example.test/'
}
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5)

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body?: Uint8Array
}

function storeWith(cfg: IconStoreConfig, respond: () => Response) {
  const calls: Captured[] = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      ...(init.body ? { body: init.body as Uint8Array } : {})
    })
    return respond()
  }) as unknown as typeof fetch
  return { store: createIconStore(cfg, { fetch: fakeFetch, now: () => NOW }), calls }
}

// Re-sign what was actually sent, so the request on the wire matches its signature.
function expectSignedAsSent(call: Captured, cfg: IconStoreConfig = CFG) {
  const url = new URL(call.url)
  const { authorization, ...headers } = call.headers
  const expected = signHeaders({
    method: call.method,
    protocol: url.protocol as 'https:' | 'http:',
    host: url.host,
    path: decodeURIComponent(url.pathname),
    headers,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    region: cfg.region,
    datetime: headers['x-amz-date']!,
    payloadHash: headers['x-amz-content-sha256']!
  })
  expect(authorization).toBe(expected.authorization)
  expect(authorization).toContain(`Credential=AKIDEXAMPLE/20260102/${cfg.region}/s3/aws4_request`)
}

describe('S3 icon store', () => {
  it('PUTs path-style with the content type and payload hash signed', async () => {
    const { store, calls } = storeWith(CFG, () => new Response(null, { status: 200 }))
    const bytes = new Uint8Array([1, 2, 3])
    await store.put('icon/agents/a1', bytes, 'image/png')
    const [call] = calls
    expect(call!.url).toBe('https://objects.example.test/icons/icon/agents/a1')
    expect(call!.method).toBe('PUT')
    expect(call!.body).toBe(bytes)
    expect(call!.headers['content-type']).toBe('image/png')
    expect(call!.headers['x-amz-date']).toBe('20260102T030405Z')
    expect(call!.headers['x-amz-content-sha256']).toBe(sha256Hex(Buffer.from(bytes)))
    expect(call!.headers.authorization).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date')
    expectSignedAsSent(call!)
  })

  it('keeps an endpoint path prefix ahead of the bucket', async () => {
    const cfg = { ...CFG, endpoint: 'http://localhost:9000/s3/' }
    const { store, calls } = storeWith(cfg, () => new Response(null, { status: 204 }))
    await store.delete('icon/orgs/o1')
    expect(calls[0]!.url).toBe('http://localhost:9000/s3/icons/icon/orgs/o1')
    expectSignedAsSent(calls[0]!, cfg)
  })

  it('throws on a failed PUT with the status', async () => {
    const { store } = storeWith(CFG, () => new Response('<Error/>', { status: 403 }))
    await expect(store.put('icon/agents/a1', new Uint8Array([1]), 'image/png')).rejects.toThrow(
      'icon store PUT icon/agents/a1 failed: 403'
    )
  })

  it('GET returns bytes and a normalized content type, and null when absent', async () => {
    const found = storeWith(
      CFG,
      () => new Response(new Uint8Array([9, 8]), { status: 200, headers: { 'content-type': 'Image/PNG; x=1' } })
    )
    expect(await found.store.get('icon/profiles/u1')).toEqual({
      bytes: new Uint8Array([9, 8]),
      contentType: 'image/png'
    })
    expect(found.calls[0]!.method).toBe('GET')
    expect(found.calls[0]!.headers['x-amz-content-sha256']).toBe(sha256Hex(''))
    expectSignedAsSent(found.calls[0]!)

    const absent = storeWith(CFG, () => new Response(null, { status: 404 }))
    expect(await absent.store.get('icon/profiles/u1')).toBeNull()
  })

  it('DELETE treats 404 as success and throws on other failures', async () => {
    await expect(
      storeWith(CFG, () => new Response(null, { status: 404 })).store.delete('icon/agents/a1')
    ).resolves.toBeUndefined()
    await expect(
      storeWith(CFG, () => new Response(null, { status: 500 })).store.delete('icon/agents/a1')
    ).rejects.toThrow('icon store DELETE icon/agents/a1 failed: 500')
  })

  it('serves public URLs from the public base', () => {
    const { store } = storeWith(CFG, () => new Response(null))
    expect(store.publicUrl('icon/agents/a1', 7)).toBe('https://cdn.example.test/icon/agents/a1?v=7')
  })
})
