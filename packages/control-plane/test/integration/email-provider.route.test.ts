/** The Email provider against real Postgres (email-integration.md §3, §3.1, §8): an address by name, never issued twice, with no credential. */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { EMAIL_V1_FEATURE } from '@agentconnect.md/protocol'
import type { IntegrationRemove, IntegrationUpsert } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { EMAIL_REUSE_MESSAGE, EMAIL_SECRET_MARKER } from '../../src/platforms/email/provider.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd3d3d3d3-dddd-4ddd-8ddd-dddddddddddd'
const DOMAIN = 'mail.example.test'
const RELAY = 'https://relay.example.test'
const ADDRESS = `helper@${DOMAIN}`

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

class SpyControl {
  readonly upserts: IntegrationUpsert[] = []
  async integrationUpsert(_daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async integrationRemove(_daemonId: string, _r: IntegrationRemove): Promise<void> {}
}

function harness(opts: { mailDomain?: string } = { mailDomain: DOMAIN }) {
  const control = new SpyControl()
  const relaySends: { type: string; payload: unknown }[] = []
  const app = buildHttpApp(prisma, { PUBLIC_RELAY_URL: RELAY }, undefined, control as unknown as ControlSender, {
    ...(opts.mailDomain ? { emailMailDomain: opts.mailDomain } : {})
  })
  app.relayReg.add({
    relayId: 'r1',
    send: (type: string, payload: unknown) => relaySends.push({ type, payload }),
    close() {}
  } as unknown as RelayChannel)
  running.push(app)
  return { app, control, relaySends }
}

async function placedAgent(): Promise<string> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['email'], runtimes: ['claude'], acp: true, features: [EMAIL_V1_FEATURE] }
  })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

const install = (app: HttpApp, agentId: string, name = 'helper', transport = 'http') =>
  app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: { platform: 'email', agentId, transport, email: { name } }
  })

const check = async (app: HttpApp, name?: string) =>
  (
    await app.app.inject({
      method: 'GET',
      url: `${ORG}/integrations/email/address${name === undefined ? '' : `?name=${encodeURIComponent(name)}`}`
    })
  ).json() as { mailDomain: string | null; address: string | null; available: boolean; reason: string | null }

describe('an Email integration from POST /integrations', () => {
  it('takes a name, stores the address with a marker, and tells the relay and the daemon', async () => {
    const agentId = await placedAgent()
    const { app, control, relaySends } = harness()

    const res = await install(app, agentId, 'Helper')
    expect(res.statusCode).toBe(201)
    const dto = res.json() as { botId: string; name: string }
    expect(dto.name).toBe(ADDRESS)

    expect(await prisma.bot.findUnique({ where: { id: dto.botId } })).toMatchObject({
      platform: 'email',
      transport: 'http',
      shareable: false,
      externalAppId: ADDRESS,
      externalTenantId: '-'
    })
    expect(await prisma.botSecret.findUnique({ where: { botId: dto.botId } })).toMatchObject({
      botToken: EMAIL_SECRET_MARKER,
      appToken: null,
      signingSecret: null
    })
    expect(await prisma.emailAddress.findMany()).toMatchObject([{ address: ADDRESS }])

    const assign = relaySends.find((send) => send.type === 'rc/bot-assign')?.payload
    expect(assign).toMatchObject({ platform: 'email', ingress: { apiAppId: ADDRESS }, secrets: {} })
    expect(JSON.stringify(assign)).not.toContain(EMAIL_SECRET_MARKER)

    expect(control.upserts).toHaveLength(1)
    expect(control.upserts[0]).toMatchObject({
      platform: 'email',
      config: { address: ADDRESS, egress: 'relay', botId: dto.botId },
      requires: [EMAIL_V1_FEATURE]
    })
    expect(JSON.stringify(control.upserts[0])).not.toContain(EMAIL_SECRET_MARKER)
  })

  it('refuses a malformed or reserved name with its own code, recording nothing', async () => {
    const agentId = await placedAgent()
    const { app } = harness()

    const codes: Record<string, string> = {
      ab: 'EMAIL_NAME_LENGTH',
      bad_name: 'EMAIL_NAME_CHARACTERS',
      postmaster: 'EMAIL_NAME_RESERVED'
    }
    for (const [name, code] of Object.entries(codes)) {
      const res = await install(app, agentId, name)
      expect(res.statusCode, name).toBe(400)
      expect(res.json().code, name).toBe(code)
    }
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.emailAddress.count()).toBe(0)
  })

  it('refuses a name another agent holds, whatever its case', async () => {
    const agentId = await placedAgent()
    const other = randomUUID()
    await seedAgent(prisma, other, { daemonId: DAEMON })
    const { app } = harness()

    expect((await install(app, agentId)).statusCode).toBe(201)
    const dup = await install(app, other, 'HELPER')
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('EMAIL_ADDRESS_TAKEN')
    expect(await prisma.bot.count({ where: { platform: 'email' } })).toBe(1)
  })

  it('never issues an address again once its integration is removed', async () => {
    const agentId = await placedAgent()
    const { app } = harness()
    const created = (await install(app, agentId)).json() as { id: string; botId: string }

    expect(
      (await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${created.id}` })).statusCode
    ).toBeLessThan(300)
    // The row is gone with its integration, and the address outlives both.
    expect(await prisma.bot.findUnique({ where: { id: created.botId } })).toBeNull()
    expect(await prisma.emailAddress.findUnique({ where: { address: ADDRESS } })).not.toBeNull()

    const again = await install(app, agentId)
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('EMAIL_ADDRESS_TAKEN')
    expect(await check(app, 'helper')).toMatchObject({ available: false, reason: 'taken' })
    expect((await install(app, agentId, 'helper-2')).statusCode).toBe(201)
  })

  it('never installs a row its agent left behind on another agent', async () => {
    const agentId = await placedAgent()
    const other = randomUUID()
    await seedAgent(prisma, other, { daemonId: DAEMON })
    const { app } = harness()
    const created = (await install(app, agentId)).json() as { id: string; botId: string }
    // An agent's deletion cascades its installs away and keeps the bot row.
    await prisma.integration.delete({ where: { id: created.id } })

    const reused = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'email', agentId: other, botId: created.botId }
    })
    expect(reused.statusCode).toBe(409)
    expect(reused.json().message).toBe(EMAIL_REUSE_MESSAGE)
    expect(await prisma.integration.count({ where: { botId: created.botId } })).toBe(0)
  })

  it('creates nothing on a deployment with no mail domain', async () => {
    const agentId = await placedAgent()
    const { app } = harness({})

    const res = await install(app, agentId)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('EMAIL_NOT_CONFIGURED')
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.emailAddress.count()).toBe(0)
    expect(await check(app)).toEqual({ mailDomain: null, address: null, available: false, reason: null })
    expect(await check(app, 'helper')).toMatchObject({ available: false, reason: 'not_configured' })
  })

  it('refuses the socket transport before taking the name', async () => {
    const agentId = await placedAgent()
    const { app } = harness()

    expect((await install(app, agentId, 'helper', 'socket')).statusCode).toBe(400)
    expect(await prisma.emailAddress.count()).toBe(0)
  })
})

describe('GET /integrations/email/address', () => {
  it('names the mail domain and says whether a name is free, without taking it', async () => {
    const { app } = harness()

    expect(await check(app)).toEqual({ mailDomain: DOMAIN, address: null, available: false, reason: null })
    expect(await check(app, 'Helper')).toEqual({ mailDomain: DOMAIN, address: ADDRESS, available: true, reason: null })
    expect(await check(app, 'postmaster')).toMatchObject({ address: null, available: false, reason: 'reserved' })
    expect(await check(app, 'a b')).toMatchObject({ available: false, reason: 'characters' })
    expect(await check(app, 'ab')).toMatchObject({ available: false, reason: 'length' })
    expect(await prisma.emailAddress.count()).toBe(0)
  })

  it('reports a name in use as taken', async () => {
    const agentId = await placedAgent()
    const { app } = harness()
    expect((await install(app, agentId)).statusCode).toBe(201)

    expect(await check(app, 'helper')).toEqual({
      mailDomain: DOMAIN,
      address: ADDRESS,
      available: false,
      reason: 'taken'
    })
  })
})
