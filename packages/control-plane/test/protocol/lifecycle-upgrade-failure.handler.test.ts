/**
 * `daemon/bootstrap/result{failed}` on a READY connection (cli-daemon-split.md §6.2).
 *
 * A live-delivered `daemon/upgrade` is acked before the install runs, so an install that
 * fails leaves the daemon running the current version and never re-registering. The daemon
 * reports the failure on the same connection, which must settle the pending op — otherwise
 * the console reads `upgrading` until the op's deadline lapses.
 */
import { describe, it, expect } from 'vitest'
import { isFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { DaemonId } from '../../src/domain/ids.js'

const DAEMON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AUTH_ID = '66666666-6666-4666-8666-666666666666'
const REG_ID = '77777777-7777-4777-8777-777777777777'

async function connectReady(h: ReturnType<typeof buildWsHarness>) {
  const token = await h.mintToken(DAEMON)
  const { stub } = h.connect()
  stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  await stub.expectFrame('auth/ok')
  stub.inject(
    'register',
    {
      host: 'host-1',
      capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
      maxAgents: 4,
      localState: { assignments: [], crons: [], leases: [] }
    },
    { id: REG_ID }
  )
  await stub.expectFrame('register/ok')
  return { stub }
}

describe('daemon/bootstrap/result on a live connection settles a failed live upgrade', () => {
  it('fails the pending op with the daemon-reported reason', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const op = await h.deps.lifecycleOps.open({
      daemonId: DaemonId(DAEMON),
      op: 'upgrade',
      targetVersion: '2.0.0',
      commandEpoch: 1n,
      deadline: new Date(h.clock.now() + 15 * 60_000)
    })

    stub.inject('daemon/bootstrap/result', {
      operationId: op.id,
      status: 'failed',
      reason: 'failed to install 2.0.0'
    })

    const ack = await stub.expectFrame('ack')
    if (!isFrame('ack')(ack)) throw new Error('expected ack')
    expect(ack.payload.ok).toBe(true)
    const settled = await h.deps.lifecycleOps.getById(op.id)
    expect(settled?.status).toBe('failed')
    expect(settled?.outcome).toBe('failed to install 2.0.0')
  })
})
