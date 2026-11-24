/**
 * The PINNED relay platform mount table (integration-plugin-architecture.md §8;
 * audit F5).
 *
 * `index.ts` no longer imports `registerSlackHttpIngress` /
 * `registerFeishuHttpIngress` by name: it asks every registered plugin for
 * `installRoutes(app, deps)` and mounts what comes back. That refactor is only
 * safe if the URLs do not move — **the public callbacks are external
 * contracts**, baked into a platform app's event-subscription config and into
 * the deployment gateway's routing, and this repo has already been bitten by a
 * public-prefix/internal-prefix mismatch turning a live callback into a 404.
 *
 * So this suite pins paths × plugin, and it does it by ENUMERATION, never by
 * re-stating the new code:
 *
 *  1. each plugin is mounted ALONE in a bare Fastify app to learn which routes
 *     it declares (the plugin is the authority for its own paths);
 *  2. the whole registry is mounted the way the bootstrap does it, and the
 *     complete route table is captured through an `onRoute` hook (Fastify is
 *     the authority for where they landed);
 *  3. the table below — the routes the pre-refactor bootstrap actually
 *     registered — is the pin, so a plugin that silently stops declaring a
 *     route, or a registry entry that never gets mounted, fails here.
 */
import { describe, it, expect, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { MATTERMOST_ACTION_PATH } from '@agentconnect.md/protocol'
import { systemClock } from '@agentconnect.md/connection'
import { buildRelayServer } from '../server.js'
import { registerMattermostActionIngress } from './mattermost/action-ingress.js'
import { relayIngressPlugins } from './registry.js'
import type { RelayIngressRouteDeps } from './contract.js'

/** TODAY'S TABLE — the routes `index.ts` registered when it named the two
 *  register functions itself. `HEAD` (Fastify's automatic twin of every GET) is
 *  omitted. */
const EXPECTED_MOUNTS: Record<string, string[]> = {
  slack: ['POST /slack/events', 'POST /slack/interactions'],
  feishu: ['POST /feishu/events'],
  // One static, shared URL — a Linear app configures exactly one webhook endpoint.
  linear: ['POST /linear/events'],
  // The HTTPS endpoint the Setup Server tells the operator to enter in the Chat app configuration.
  // …and the ticketed attachment download a daemon of the deployment app's row reads from.
  googlechat: ['POST /googlechat/events', 'GET /googlechat/media/*'],
  // The messaging endpoint the admin enters in the Teams bot registration.
  msteams: ['POST /msteams/messages'],
  // The inbound URL the Setup Server tells the operator to configure the ingress Worker with.
  email: ['POST /email/inbound', 'POST /email/send/*']
}

const routeDeps = (): RelayIngressRouteDeps => ({
  // The bootstrap's accessor is late-bound and legitimately empty at mount
  // time — routes register before the manager exists.
  manager: () => undefined,
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
})

/** Every route an app ends up serving, as `METHOD /path`, captured from
 *  Fastify rather than from the code under test. */
async function routesOf(mount: (app: FastifyInstance) => void): Promise<string[]> {
  const app = Fastify()
  const seen: string[] = []
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) if (method !== 'HEAD') seen.push(`${method} ${route.url}`)
  })
  mount(app)
  await app.ready()
  await app.close()
  return seen.sort()
}

describe('relay platform route mounts', () => {
  it.each(relayIngressPlugins.map((plugin) => plugin.platformId))('%s declares its own paths', async (platformId) => {
    const plugin = relayIngressPlugins.find((p) => p.platformId === platformId)!
    const expected = EXPECTED_MOUNTS[platformId]
    // A new platform lands here first: add its row to the table above, having
    // confirmed the paths are the ones its provider console is configured with.
    expect(expected, `no pinned mount table for '${platformId}'`).toBeDefined()
    expect(await routesOf((app) => plugin.installRoutes(app, routeDeps()))).toEqual([...expected!].sort())
  })

  it('mounting the whole registry lands exactly the pinned table', async () => {
    const mounted = await routesOf((app) => {
      for (const plugin of relayIngressPlugins) plugin.installRoutes(app, routeDeps())
    })
    expect(mounted).toEqual(Object.values(EXPECTED_MOUNTS).flat().sort())
  })

  it('every registered platform actually mounts something', async () => {
    for (const plugin of relayIngressPlugins) {
      expect(
        await routesOf((app) => plugin.installRoutes(app, routeDeps())),
        `'${plugin.platformId}' registered no routes`
      ).not.toHaveLength(0)
    }
  })

  it('mounts POST /mattermost/actions alongside the plugin registry on the Relay server', async () => {
    const mmDeps = {
      masterSecret: () => 'test-secret',
      getDaemon: () => undefined,
      daemonForAgent: () => undefined,
      orgForAgent: () => undefined,
      clock: systemClock,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    }
    expect(await routesOf((app) => registerMattermostActionIngress(app, mmDeps))).toEqual([
      `POST ${MATTERMOST_ACTION_PATH}`
    ])

    const server = buildRelayServer({ isReady: () => true, relayId: () => 'relay-1' }, { logger: false })
    const mounted: string[] = []
    server.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) if (method !== 'HEAD') mounted.push(`${method} ${route.url}`)
    })
    for (const plugin of relayIngressPlugins) plugin.installRoutes(server, routeDeps())
    registerMattermostActionIngress(server, mmDeps)
    await server.ready()
    try {
      expect(mounted.sort()).toEqual(
        [...Object.values(EXPECTED_MOUNTS).flat(), `POST ${MATTERMOST_ACTION_PATH}`].sort()
      )
      const res = await server.inject({ method: 'POST', url: MATTERMOST_ACTION_PATH, payload: {} })
      expect(res.statusCode).not.toBe(404)
    } finally {
      await server.close()
    }
  })
})
