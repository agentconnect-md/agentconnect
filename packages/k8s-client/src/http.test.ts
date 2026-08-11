import { afterEach, describe, expect, it } from 'vitest'
import { K8sApiError, K8sHttp } from './http.js'
import { closeFakeApiServers, fakeApiServer } from './testing/index.js'

afterEach(closeFakeApiServers)

describe('K8sHttp', () => {
  it('re-reads the bearer token for every request', async () => {
    const { config, tokens } = await fakeApiServer(() => ({ json: { ok: true } }))
    const http = new K8sHttp(config)
    await http.json({ method: 'GET', path: '/healthz' })
    await http.json({ method: 'GET', path: '/healthz' })
    expect(tokens).toEqual(['token-1', 'token-2'])
  })

  it('surfaces a Status body as a typed error callers can branch on', async () => {
    const { config } = await fakeApiServer(() => ({
      status: 409,
      json: { kind: 'Status', reason: 'AlreadyExists', message: 'sandboxclaims "agent-a" already exists' }
    }))
    const http = new K8sHttp(config)
    const error = await http.json({ method: 'POST', path: '/x' }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(K8sApiError)
    const typed = error as K8sApiError
    expect(typed.status).toBe(409)
    expect(typed.reason).toBe('AlreadyExists')
    expect(typed.isAlreadyExists).toBe(true)
    expect(typed.isConflict).toBe(true)
    expect(typed.message).toContain('already exists')
  })

  it('treats a 410 as expired regardless of which side reports it', async () => {
    expect(new K8sApiError(410, undefined, 'gone').isExpired).toBe(true)
    expect(new K8sApiError(0, 'Expired', 'too old resource version').isExpired).toBe(true)
    expect(new K8sApiError(404, 'NotFound', 'nope').isExpired).toBe(false)
  })
})
