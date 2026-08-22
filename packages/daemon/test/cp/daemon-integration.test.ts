import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Daemon } from '../../src/daemon.js'
import { LocalStore } from '../../src/store/local-store.js'
import { statePath } from '../../src/paths.js'
import { CpRoutingLayer } from '../../src/router/cp-routing-layer.js'
import { resolveCpRule } from '../../src/router/routing-rule.js'
import { routeRules } from '../../src/router/routing-table.js'
import type { NormalizedMessage } from '../../src/messages/normalized.js'
import { fakeSlackAppFactory } from '../fakes/slack-app.js'

const roots: string[] = []
function freshRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'ac-cp-'))
  roots.push(r)
  return r
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('Daemon ↔ CP integration', () => {
  it('starts local-first when the CP is enabled but unreachable', async () => {
    const root = freshRoot()
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: true, url: 'wss://127.0.0.1:9/daemon/ws', token: 'tok', heartbeatMs: 15000 }
      }) + '\n'
    )
    // Must not throw or hang even though the CP refuses the connection.
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root })
    await daemon.start()
    expect(true).toBe(true)
    await daemon.stop()
  })

  it('mints and persists a daemonId when none is configured', async () => {
    const root = freshRoot()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root })
    await daemon.start()
    await daemon.stop()
    const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    expect(cfg.daemonId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('routes by a persisted CP assignment after restart (DEGRADED autonomy)', async () => {
    // Seam choice: assert the daemon's resolver CHAIN composed from the real LocalStore,
    // rather than booting a full Daemon (whose start() opens a real Slack Socket-Mode
    // connection for any agent with a Slack integration — not stubbable offline without a
    // new Slack-factory injection seam, which is out of scope for this task). This proves
    // the end-to-end invariant the daemon relies on: a persisted CP assignment survives a
    // restart (fresh CpRoutingLayer from store) → resolves to the local Slack integration
    // (resolveCpRule) → drives routeRules. It composes exactly what Daemon.routeFor() does.
    const root = freshRoot()
    // pre-seed the CP routing layer in the store (channel C1 → agentA, auto), epoch 1
    const store = await LocalStore.open(statePath(root))
    await store.setCpRouting(
      1,
      JSON.stringify({
        'slack:C1:-': [{ agentId: 'agentA', scope: { channel: 'C1' }, match: { kind: 'auto' }, epoch: 1 }]
      }),
      JSON.stringify([])
    )
    await store.close()

    // "Restart": a fresh CpRoutingLayer rehydrates from the persisted store.
    const store2 = await LocalStore.open(statePath(root))
    const layer = new CpRoutingLayer({
      load: async () => {
        const row = await store2.getCpRouting()
        return row
          ? {
              routingEpoch: row.routingEpoch,
              assignments: JSON.parse(row.assignments),
              globalRules: JSON.parse(row.globalRules)
            }
          : undefined
      },
      save: async (s) =>
        await store2.setCpRouting(s.routingEpoch, JSON.stringify(s.assignments), JSON.stringify(s.globalRules))
    })
    await layer.hydrate()
    // The local agent with id == CP agentId and a Slack integration makes the rule servable.
    const resolveCpAgent = (agentId: string) =>
      agentId === 'agentA' ? { integrationId: 'int1', botUserId: 'B1', platform: 'slack' } : null
    const merged = layer
      .effectiveRules()
      .map((r) => resolveCpRule(r, resolveCpAgent))
      .filter((r): r is NonNullable<typeof r> => r !== null)
    await store2.close()

    const msg: NormalizedMessage = {
      msgId: 'm1',
      traceId: 't1',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      sender: { id: 'U1', isBot: false },
      text: 'hi',
      mentionedBots: [],
      isDm: false
    }
    expect(routeRules(msg, merged, () => null)).toEqual({ agentId: 'agentA', integrationId: 'int1', via: 'auto' })
  })
})
