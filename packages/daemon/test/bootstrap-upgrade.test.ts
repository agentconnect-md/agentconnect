import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEnvelope, encode } from '@agentconnect.md/protocol'
import { bootstrapControlPlane, runBootstrapUpgrade } from '../src/bootstrap-upgrade.js'
import { FakeTransport } from './cp/fake-transport.js'

const DAEMON_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SERVER_TIME = '2026-08-10T00:00:00.000Z'
const roots: string[] = []

function rootWithCli(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentconnect-bootstrap-'))
  roots.push(root)
  const cli = join(root, 'agentconnect-cli.js')
  writeFileSync(cli, '')
  writeFileSync(join(root, 'cli-entry'), `${cli}\n`)
  return root
}

async function waitForSent(transport: FakeTransport, type: string): Promise<Record<string, unknown>> {
  await vi.waitFor(() => {
    if (!transport.sent.some((text) => JSON.parse(text).type === type)) throw new Error(`${type} not sent`)
  })
  return JSON.parse(transport.sent.find((text) => JSON.parse(text).type === type)!) as Record<string, unknown>
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('auth-only daemon bootstrap upgrade', () => {
  it('reads the persisted daemon identity and applies the enabled default', () => {
    const root = rootWithCli()
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        daemonId: DAEMON_ID,
        controlPlane: { url: 'ws://cp.test', key: 'key' }
      })
    )

    expect(bootstrapControlPlane({ root })).toEqual({ url: 'ws://cp.test', key: 'key', daemonId: DAEMON_ID })
  })

  it('advertises bootstrap v1 and continues when CP has no pending upgrade', async () => {
    const transport = new FakeTransport()
    const install = vi.fn()
    const run = runBootstrapUpgrade(
      {
        root: rootWithCli(),
        supervisor: 'cli',
        overrides: { apiUrl: 'ws://cp.test', apiKey: 'key' }
      },
      { connect: async () => transport, install, log: { info: vi.fn(), error: vi.fn() } }
    )
    const auth = await waitForSent(transport, 'auth')
    expect(auth.payload).toMatchObject({ bootstrapProtocolVersion: 1 })
    transport.pushInbound(
      encode(
        buildEnvelope(
          'auth/ok',
          { daemonId: DAEMON_ID, sessionEpoch: 1, heartbeatSec: 15, serverTime: SERVER_TIME },
          { corr: auth.id as string }
        )
      )
    )
    await expect(run).resolves.toBe('continue')
    expect(install).not.toHaveBeenCalled()
  })

  it('installs the directed version, reports it, and requests a planned restart', async () => {
    const transport = new FakeTransport()
    const install = vi.fn(async () => true)
    const run = runBootstrapUpgrade(
      {
        root: rootWithCli(),
        supervisor: 'service',
        overrides: { apiUrl: 'ws://cp.test', apiKey: 'key' }
      },
      { connect: async () => transport, install, log: { info: vi.fn(), error: vi.fn() } }
    )
    const auth = await waitForSent(transport, 'auth')
    transport.pushInbound(
      encode(
        buildEnvelope(
          'auth/ok',
          {
            daemonId: DAEMON_ID,
            sessionEpoch: 2,
            heartbeatSec: 15,
            serverTime: SERVER_TIME,
            lifecycle: { operationId: 'op-1', action: 'upgrade', targetVersion: '9.9.9' }
          },
          { corr: auth.id as string }
        )
      )
    )
    const result = await waitForSent(transport, 'daemon/bootstrap/result')
    expect(result.payload).toEqual({ operationId: 'op-1', status: 'installed' })
    transport.pushInbound(encode(buildEnvelope('ack', { ok: true }, { corr: result.id as string })))

    await expect(run).resolves.toBe('restart')
    expect(install).toHaveBeenCalledWith(expect.any(String), '9.9.9', expect.any(String), expect.any(Object))
  })
})
