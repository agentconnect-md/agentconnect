import { afterEach, describe, expect, it } from 'vitest'
import { poolBootstrapPort, startPoolBootstrap, type PoolBootstrap } from './pool-bootstrap.js'
import type { Registration } from './registration.js'

const registration: Registration = {
  cpUrl: 'https://cp.example.com',
  channelUrl: 'wss://cp.example.com/v1/computers/ws',
  computerId: '00000000-0000-4000-8000-000000000001',
  orgId: 'org_1',
  apiKeyId: 'key_1',
  apiKey: 'secret',
  registeredAt: '2026-10-21T00:00:00.000Z'
}

let running: PoolBootstrap | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function start(stored?: Registration, register?: (token: string, name: string) => Promise<Registration>) {
  let current = stored
  const spent: Array<{ token: string; name: string }> = []
  const logs: string[] = []
  running = await startPoolBootstrap({
    port: 0,
    host: '127.0.0.1',
    load: () => current,
    register:
      register ??
      (async (token, name) => {
        spent.push({ token, name })
        current = registration
        return registration
      }),
    log: (line) => logs.push(line)
  })
  const base = `http://127.0.0.1:${running.address.port}`
  return { base, spent, logs, bootstrap: running }
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/pool/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

describe('pool bootstrap', () => {
  it('reads its port from the pod template and refuses a bad one', () => {
    expect(poolBootstrapPort({})).toBeUndefined()
    expect(poolBootstrapPort({ AGENTCONNECT_POOL_BOOTSTRAP_PORT: '7690' })).toBe(7690)
    expect(() => poolBootstrapPort({ AGENTCONNECT_POOL_BOOTSTRAP_PORT: 'x' })).toThrow(/not a valid port/)
  })

  it('waits unregistered until a member pushes a token, spends it once, and never logs it', async () => {
    const { base, spent, logs, bootstrap } = await start()
    expect(await (await fetch(`${base}/pool/status`)).json()).toEqual({ registered: false })
    const res = await post(base, { token: 'acr_secret', name: ' Agent desktop ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ registered: true, computerId: registration.computerId })
    await expect(bootstrap.registered).resolves.toEqual(registration)
    expect(spent).toEqual([{ token: 'acr_secret', name: 'Agent desktop' }])
    expect(await (await fetch(`${base}/pool/status`)).json()).toEqual({
      registered: true,
      computerId: registration.computerId
    })
    // A second push finds it registered and spends nothing.
    expect((await post(base, { token: 'acr_other', name: 'x' })).status).toBe(409)
    expect(spent).toHaveLength(1)
    expect(logs.join('\n')).not.toContain('acr_secret')
  })

  it('is registered at once when its volume already holds a key, as after a wake', async () => {
    const { base, bootstrap } = await start(registration)
    await expect(bootstrap.registered).resolves.toEqual(registration)
    expect(await (await fetch(`${base}/pool/status`)).json()).toMatchObject({ registered: true })
  })

  it('treats a revoked key as unregistered', async () => {
    const { base } = await start({ ...registration, revokedAt: '2026-10-21T01:00:00.000Z' })
    expect(await (await fetch(`${base}/pool/status`)).json()).toEqual({ registered: false })
  })

  it('answers a refused token with 502 and stays unregistered for the next push', async () => {
    let fail = true
    const { base, logs } = await start(undefined, async () => {
      if (fail) throw new Error('invalid or expired registration token')
      return registration
    })
    expect((await post(base, { token: 'acr_bad', name: 'n' })).status).toBe(502)
    expect(logs.join('\n')).toMatch(/managed registration failed/)
    fail = false
    expect((await post(base, { token: 'acr_good', name: 'n' })).status).toBe(200)
  })

  it('refuses a malformed push and unknown paths', async () => {
    const { base } = await start()
    expect((await post(base, { token: '' })).status).toBe(400)
    expect((await fetch(`${base}/pool/register`, { method: 'POST', body: 'not json' })).status).toBe(400)
    expect((await fetch(`${base}/mcp`)).status).toBe(404)
  })
})
