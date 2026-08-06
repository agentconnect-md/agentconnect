import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from './proxy'

const originalPublicWebUrl = process.env.PUBLIC_WEB_URL

afterEach(() => {
  if (originalPublicWebUrl === undefined) delete process.env.PUBLIC_WEB_URL
  else process.env.PUBLIC_WEB_URL = originalPublicWebUrl
})

describe('canonical Web origin', () => {
  it('redirects localhost while preserving the path and query', () => {
    process.env.PUBLIC_WEB_URL = 'http://app.agentconnect.localhost:3000'

    const response = proxy(
      new NextRequest('http://localhost:3000/login?next=%2Fsettings', { headers: { host: 'localhost:3000' } })
    )

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('http://app.agentconnect.localhost:3000/login?next=%2Fsettings')
  })

  it('does not redirect the container health-check origin', () => {
    process.env.PUBLIC_WEB_URL = 'http://app.agentconnect.localhost:3000'

    const response = proxy(new NextRequest('http://127.0.0.1:8080/', { headers: { host: '127.0.0.1:8080' } }))

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(new URL(response.headers.get('x-middleware-rewrite')!).pathname).toBe('/-/home')
  })
})
