/** A package that embeds the Control Plane adds routes and capabilities through `buildApp({ extension })`; without one nothing changes. */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { FakeClock } from '../fakes/fake-clock.js'
import type {
  ControlPlaneExtensionContext,
  ControlPlaneExtensionFactory,
  OrgCapabilityState
} from '../../src/extension.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const config = () =>
  AppConfigSchema.parse({
    DATABASE_URL: 'postgresql://extension/ignored',
    API_KEY_PEPPER: 'extension-api-key-pepper-0123456789abcdef',
    SECRETS_PROVIDER: 'memory'
  })

let running: App | undefined
afterEach(async () => {
  await running?.shutdown()
  running = undefined
})

function start(extension?: ControlPlaneExtensionFactory, clock = new FakeClock(0)): App {
  running = buildApp({
    prisma,
    config: config(),
    clock,
    secretsProvider: new MemorySecretsProvider(),
    ...(extension ? { extension } : {})
  })
  return running
}

describe('a Control Plane with no extension', () => {
  it('names no optional settings area and mounts nothing extra', async () => {
    const { http } = start()
    const res = await http.inject({ method: 'GET', url: `${ORG}/capabilities` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ capabilities: {} })
    expect((await http.inject({ method: 'GET', url: `${ORG}/extension-probe` })).statusCode).toBe(404)
  })
})

describe('a Control Plane with an extension', () => {
  const extension: ControlPlaneExtensionFactory = () => ({
    orgRoutes: async (scope) => {
      scope.get('/extension-probe', async (req) => ({ orgId: req.orgCtx!.orgId, role: req.orgCtx!.role }))
    },
    rootRoutes: async (root) => {
      root.get('/extension-root', async (req) => ({ signedIn: req.principal !== undefined }))
    },
    capabilities: async (orgId): Promise<Record<string, OrgCapabilityState>> =>
      orgId === DEFAULT_ORG_ID ? { directory: 'active', export: 'read_only' } : {}
  })

  it('is handed the database and the clock when the graph is assembled', async () => {
    const clock = new FakeClock(42)
    let seen: ControlPlaneExtensionContext | undefined
    start((context) => {
      seen = context
      return {}
    }, clock)
    expect(seen?.clock).toBe(clock)
    // The directory's commands come with it, so shared tables are never written around core.
    expect(await seen!.directoryMembers.setRole(DEFAULT_ORG_ID, 'connection-1', 'ext-nobody', 'viewer')).toEqual({
      outcome: 'not_found'
    })
    expect(await seen!.prisma.org.count({ where: { id: DEFAULT_ORG_ID } })).toBe(1)
  })

  it('answers the organization’s capabilities from it', async () => {
    const { http } = start(extension)
    expect((await http.inject({ method: 'GET', url: `${ORG}/capabilities` })).json()).toEqual({
      capabilities: { directory: 'active', export: 'read_only' }
    })
  })

  it('mounts its organization routes behind the organization guard', async () => {
    const { http } = start(extension)
    const member = await http.inject({ method: 'GET', url: `${ORG}/extension-probe` })
    expect(member.statusCode).toBe(200)
    expect(member.json()).toEqual({ orgId: DEFAULT_ORG_ID, role: 'owner' })
    // An organization the caller is not in reads as absent, as on every core route.
    const foreign = await prisma.org.create({
      data: { name: 'Elsewhere', slug: `elsewhere-${randomUUID().slice(0, 8)}` }
    })
    expect((await http.inject({ method: 'GET', url: `/api/v1/orgs/${foreign.id}/extension-probe` })).statusCode).toBe(
      404
    )
    expect((await http.inject({ method: 'GET', url: `/api/v1/orgs/${foreign.id}/capabilities` })).statusCode).toBe(404)
  })

  it('mounts its root routes under both prefixes with no sign-in in front of them', async () => {
    const { http } = start(extension)
    for (const url of ['/api/v1/extension-root', '/v1/extension-root']) {
      const res = await http.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ signedIn: false })
    }
  })
})
