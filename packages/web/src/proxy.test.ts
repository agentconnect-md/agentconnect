import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { proxy } from './proxy'

const DOMAIN = 'example-usercontent.net'
const CONSOLE = 'https://console.example.test'
const CONTENT = `a${'0123456789abcdef'.repeat(2)}r1.${DOMAIN}`

const request = (host: string, path: string, method = 'GET') =>
  new NextRequest(`https://${host}${path}`, { method, headers: { host } })

describe('proxy on the content domain', () => {
  beforeEach(() => {
    vi.stubEnv('ARTIFACTS_CONTENT_DOMAIN', DOMAIN)
    vi.stubEnv('PUBLIC_WEB_URL', CONSOLE)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('answers the shim and the worker script, without cookies', async () => {
    const shim = proxy(request(CONTENT, '/__ac/shim'))
    expect(shim.status).toBe(200)
    expect(shim.headers.get('content-security-policy')).toContain(`frame-ancestors ${CONSOLE}`)
    expect(shim.headers.get('set-cookie')).toBeNull()
    expect(await shim.text()).toContain('<!doctype html>')

    const worker = proxy(request(CONTENT, '/__ac/sw.js'))
    expect(worker.status).toBe(200)
    expect(worker.headers.get('service-worker-allowed')).toBe('/')
    expect(worker.headers.get('set-cookie')).toBeNull()
  })

  it.each([
    '/',
    '/home',
    '/-/agents',
    '/login',
    '/_next/static/chunks/app.js',
    '/_next/image?url=%2Ficon.svg&w=64&q=75',
    '/favicon.ico',
    '/icon.svg',
    '/apple-icon.png',
    '/cp/api/v1/me',
    '/api/acp-registry',
    '/llms.txt',
    '/index.html',
    '/%5F%5Fac/sw.js'
  ])('answers 404 for %s, never the app', async (path) => {
    const response = proxy(request(CONTENT, path))
    expect(response.status).toBe(404)
    expect(response.headers.get('x-middleware-rewrite')).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBeNull()
    expect(await response.text()).toBe('Not found')
  })

  it.each([DOMAIN, `www.${DOMAIN}`, `a1r1.${DOMAIN}`, `x.${CONTENT}`])('answers 404 for every path on %s', (host) => {
    expect(proxy(request(host, '/__ac/shim')).status).toBe(404)
    expect(proxy(request(host, '/_next/static/chunks/app.js')).status).toBe(404)
  })

  it('sends no console framing headers on the content domain', () => {
    for (const path of ['/__ac/shim', '/__ac/sw.js', '/agents']) {
      const response = proxy(request(CONTENT, path))
      expect(response.headers.get('x-frame-options')).toBeNull()
      expect(response.headers.get('content-security-policy')).not.toContain("frame-ancestors 'self'")
    }
  })

  it('leaves the console host unchanged', () => {
    expect(proxy(request('console.example.test', '/agents')).headers.get('x-middleware-rewrite')).toBe(
      'https://console.example.test/-/agents'
    )
    expect(proxy(request('console.example.test', '/_next/static/chunks/app.js')).headers.get('x-middleware-next')).toBe(
      '1'
    )
    expect(proxy(request('console.example.test', '/__ac/shim')).headers.get('x-middleware-next')).toBe('1')
  })
})

describe('proxy on the console', () => {
  beforeEach(() => {
    vi.stubEnv('ARTIFACTS_CONTENT_DOMAIN', DOMAIN)
    vi.stubEnv('PUBLIC_WEB_URL', CONSOLE)
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each([
    '/',
    '/agents',
    '/acme/artifacts/0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d',
    '/login',
    '/_next/static/chunks/app.js'
  ])('refuses foreign framing of %s', (path) => {
    const response = proxy(request('console.example.test', path))
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'")
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })
})

describe('proxy without a content domain', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('treats every host as the console', () => {
    vi.stubEnv('ARTIFACTS_CONTENT_DOMAIN', '')
    expect(proxy(request(CONTENT, '/agents')).headers.get('x-middleware-rewrite')).toBe(`https://${CONTENT}/-/agents`)
    expect(proxy(request(CONTENT, '/agents')).headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })
})
