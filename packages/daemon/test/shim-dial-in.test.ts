import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { ShimDialer } from '../src/shim/dialer.js'
import { ShimServer } from '../src/shim/server.js'
import { ShimSession } from '../src/shim/session.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import { SHIM_TOKEN_AUDIENCE } from '../src/shim/protocol.js'

const clients: ShimClient[] = []
const dialers: ShimDialer[] = []
const servers: ShimServer[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop()
  for (const dialer of dialers.splice(0)) dialer.stop()
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

async function sandbox(options: { handle?: (capability: string, payload: unknown) => Promise<unknown> } = {}) {
  const server = new ShimServer()
  servers.push(server)
  const port = await server.start(0, '127.0.0.1')
  const client = new ShimClient({
    endpoint: 'accepted-daemon-channel',
    acceptDialIn: true,
    dial: () => server.nextTransport() as Promise<ShimTransport>,
    readToken: () => 'projected-token',
    workspaceRoot: '/agent',
    ...(options.handle ? { handle: options.handle as never } : {}),
    log: { info: () => {}, warn: () => {} }
  })
  clients.push(client)
  void client.start().catch(() => undefined)
  return { endpoint: `ws://127.0.0.1:${port}`, client }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function record(generation = 1): SpawnRecord {
  return {
    agentId: 'agent-a',
    sandboxUid: 'sandbox-uid-1',
    generation,
    grants: ['materialize'],
    podName: 'sandbox-pod-1'
  }
}

describe('sandbox shim dial-in', () => {
  it('lets the daemon dial a pod IP, TokenReviews its identity, and serves a granted request', async () => {
    const served: unknown[] = []
    const { endpoint } = await sandbox({
      handle: async (_capability, payload) => {
        served.push(payload)
        return { written: true }
      }
    })
    const reviewToken = vi.fn(async () => ({
      authenticated: true,
      podName: 'sandbox-pod-1',
      podUid: 'pod-uid-1'
    }))
    const dialer = new ShimDialer({
      verifier: { reviewToken },
      log: { info: () => {}, warn: () => {} }
    })
    dialers.push(dialer)

    const connection = await dialer.connect(endpoint, record(), 5_000)
    const session = new ShimSession('agent-a', 1, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    })
    session.attach(connection)

    await expect(session.request('materialize', { path: 'config.json' })).resolves.toEqual({ written: true })
    expect(served).toEqual([{ path: 'config.json' }])
    expect(reviewToken).toHaveBeenCalledWith('projected-token', [SHIM_TOKEN_AUDIENCE])
    expect(connection.binding).toMatchObject({ podName: 'sandbox-pod-1', podUid: 'pod-uid-1', generation: 1 })
    expect(connection.workspaceRoot).toBe('/agent')
    expect(
      dialer.authorize({
        credential: connection.issuedCredential,
        generation: 1,
        capability: 'materialize'
      }).ok
    ).toBe(true)
  })

  it('refuses a pod whose reviewed identity does not match the Pod IP launch record', async () => {
    const { endpoint } = await sandbox()
    const dialer = new ShimDialer({
      verifier: {
        reviewToken: async () => ({ authenticated: true, podName: 'different-pod', podUid: 'pod-uid-2' })
      },
      log: { info: () => {}, warn: () => {} }
    })
    dialers.push(dialer)

    await expect(dialer.connect(endpoint, record(), 1)).rejects.toThrow(/pod identity|not accepted|connect/)
    expect(dialer.connectionsFor('agent-a')).toEqual([])
  })

  it('waits for the replacement connection while a bound channel is reconnecting', async () => {
    const { endpoint } = await sandbox()
    const dialer = new ShimDialer({
      verifier: {
        reviewToken: async () => ({ authenticated: true, podName: 'sandbox-pod-1', podUid: 'pod-uid-1' })
      },
      log: { info: () => {}, warn: () => {} }
    })
    dialers.push(dialer)

    const first = await dialer.connect(endpoint, record(), 8_000)
    first.close('force reconnect')
    await waitFor(() => dialer.connectionsFor('agent-a').length === 0)

    const replacement = await dialer.connect(endpoint, record(), 8_000)
    expect(replacement).not.toBe(first)
    expect(dialer.connectionsFor('agent-a')).toEqual([replacement])
  }, 10_000)

  it('times out an accepted socket whose identity verification never completes', async () => {
    const { endpoint } = await sandbox()
    const dialer = new ShimDialer({
      verifier: { reviewToken: () => new Promise(() => {}) },
      log: { info: () => {}, warn: () => {} }
    })
    dialers.push(dialer)

    await expect(dialer.connect(endpoint, record(), 25)).rejects.toThrow(/binding timed out/)
    expect(dialer.connectionsFor('agent-a')).toEqual([])
  })
})
