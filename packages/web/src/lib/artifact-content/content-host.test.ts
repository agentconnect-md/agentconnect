import { describe, expect, it } from 'vitest'
import {
  artifactContentOrigin,
  contentHostConfig,
  contentHostResponse,
  contentHostRevision,
  type ContentHostConfig
} from './content-host'

const DOMAIN = 'example-usercontent.net'
const CONSOLE = 'https://console.example.test'
const ID = '0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const LABEL = 'a0f8e2c1a5b6d4e7f8a9b0c1d2e3f4a5br3'
const config: ContentHostConfig = { domain: DOMAIN, consoleOrigin: CONSOLE }

describe('contentHostConfig', () => {
  it('reads the domain and the console origin from the environment', () => {
    expect(
      contentHostConfig({ ARTIFACTS_CONTENT_DOMAIN: ' Example-Usercontent.NET. ', PUBLIC_WEB_URL: `${CONSOLE}/x/` })
    ).toEqual({ domain: DOMAIN, consoleOrigin: CONSOLE })
  })

  it('keeps the content domain without a console origin, so its hosts still answer 404', () => {
    expect(contentHostConfig({ ARTIFACTS_CONTENT_DOMAIN: DOMAIN })).toEqual({
      domain: DOMAIN,
      consoleOrigin: undefined
    })
    expect(contentHostConfig({ ARTIFACTS_CONTENT_DOMAIN: DOMAIN, PUBLIC_WEB_URL: 'ftp://x.test' })?.consoleOrigin).toBe(
      undefined
    )
  })

  it.each([undefined, '', '*.example-usercontent.net', 'https://example-usercontent.net', 'example.net:443', 'a..b'])(
    'is off for %j',
    (domain) => expect(contentHostConfig({ ARTIFACTS_CONTENT_DOMAIN: domain, PUBLIC_WEB_URL: CONSOLE })).toBeUndefined()
  )
})

describe('contentHostRevision', () => {
  it('parses a revision label, ignoring case, a port and a trailing dot', () => {
    const revision = { artifactId: ID, revision: 3 }
    expect(contentHostRevision(`${LABEL}.${DOMAIN}`, DOMAIN)).toEqual(revision)
    expect(contentHostRevision(`${LABEL.toUpperCase()}.${DOMAIN}.:8443`, DOMAIN)).toEqual(revision)
  })

  it('round-trips the origin a revision renders at', () => {
    expect(artifactContentOrigin(ID, 3, DOMAIN)).toBe(`https://${LABEL}.${DOMAIN}`)
  })

  it.each([
    DOMAIN,
    `www.${DOMAIN}`,
    `a${'0'.repeat(31)}r1.${DOMAIN}`,
    `a${'0'.repeat(32)}r0.${DOMAIN}`,
    `a${'0'.repeat(32)}r01.${DOMAIN}`,
    `a${'g'.repeat(32)}r1.${DOMAIN}`,
    `x.${LABEL}.${DOMAIN}`
  ])('marks %s as a content host with no revision', (host) => expect(contentHostRevision(host, DOMAIN)).toBeNull())

  it.each(['console.example.test', `${LABEL}.other-${DOMAIN}`, `${LABEL}.${DOMAIN}.evil.test`, ''])(
    'leaves %j to the console',
    (host) => expect(contentHostRevision(host, DOMAIN)).toBeUndefined()
  )
})

describe('contentHostResponse', () => {
  const host = `${LABEL}.${DOMAIN}`
  const get = (pathname: string, extra: Partial<{ method: string; host: string }> = {}) =>
    contentHostResponse(config, { method: 'GET', host, pathname, ...extra })

  it('serves the shim with its own policy and nothing that sets a cookie', () => {
    const shim = get('/__ac/shim')
    expect(shim.status).toBe(200)
    expect(shim.headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(shim.headers['Cache-Control']).toBe('no-store')
    expect(shim.headers['Content-Security-Policy']).toContain(`frame-ancestors ${CONSOLE}`)
    expect(Object.keys(shim.headers).map((k) => k.toLowerCase())).not.toContain('set-cookie')
  })

  it('serves the worker script for scope / and uncached', () => {
    const worker = get('/__ac/sw.js')
    expect(worker.status).toBe(200)
    expect(worker.headers).toMatchObject({
      'Content-Type': 'text/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-store'
    })
    expect(worker.body).toContain(`frame-ancestors 'self' ${CONSOLE}`)
  })

  it('answers HEAD without a body', () => {
    const head = get('/__ac/shim', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
  })

  it.each([
    '/',
    '/index.html',
    '/__ac/',
    '/__ac/shim/',
    '/__ac/other',
    '/__AC/shim',
    '/%5F%5Fac/shim',
    '/__ac/sw.js/',
    '/_next/static/chunks/main.js',
    '/favicon.ico',
    '/cp/api/v1/me',
    '/api/acp-registry',
    '/-/home'
  ])('answers 404 for %s', (pathname) => {
    const miss = get(pathname)
    expect(miss.status).toBe(404)
    expect(miss.headers['Content-Security-Policy']).toBe("default-src 'none'; frame-ancestors 'none'")
  })

  it('answers 404 for another method, a malformed label, the bare domain or no console origin', () => {
    expect(get('/__ac/shim', { method: 'POST' }).status).toBe(404)
    expect(get('/__ac/shim', { host: `www.${DOMAIN}` }).status).toBe(404)
    expect(get('/__ac/sw.js', { host: DOMAIN }).status).toBe(404)
    expect(
      contentHostResponse({ domain: DOMAIN, consoleOrigin: undefined }, { method: 'GET', host, pathname: '/__ac/shim' })
        .status
    ).toBe(404)
  })
})
