/**
 * Phase 4 — BFF REST / C2 first failing test (design §6 Phase 4, §5.6b).
 *
 * Drives the C2 REST surface through `app.inject` — DB-backed, NO socket. The
 * same C6 repos the WS edge writes are read/written here through the Fastify
 * routes, so REST and WS share one Postgres. `humanAuth`'s `devAuth` stub (no
 * `OIDC_ISSUER`) admits every request and injects a fixed principal.
 *
 * Red→Green coverage:
 *  - GET /daemons        → the registry read model (rows seeded directly).
 *  - POST /agents → GET /agents/:id  → round-trips through the real `AgentRepo`.
 *  - POST/GET/DELETE /workspaces     → CRUD through the real `WorkspaceRepo`.
 *  - POST/GET/DELETE /crons          → CRUD through the real `CronRepo`.
 *  - humanAuth devAuth stub admits (a principal is attached, no 401).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

function build(): HttpApp {
  const app = buildHttpApp(prisma)
  running = app
  return app
}

describe('C2 BFF REST — agents/daemons/workspaces/crons over app.inject', () => {
  it('GET /daemons returns the read model with status overlaid from the live index', async () => {
    const d1 = 'a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const d2 = 'b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await seedDaemon(prisma, d1, { sessionEpoch: 3n, maxAgents: 5 })
    await seedDaemon(prisma, d2, { sessionEpoch: 1n, maxAgents: 2 })

    // Both rows have durable status `ready`; only d1 is actually connected, so
    // d2 must read `offline` even though the DB still says `ready` (the bug fix).
    const live: DaemonLiveness = {
      get: (id) => (id === d1 ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
    }
    running = buildHttpApp(prisma, undefined, live)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })

    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ daemonId: string; status: string; sessionEpoch: number; maxAgents: number }>
    const ids = body.map((d) => d.daemonId).sort()
    expect(ids).toEqual([d1, d2].sort())
    const row1 = body.find((d) => d.daemonId === d1)!
    expect(row1.status).toBe('ready') // live + reachable
    expect(row1.sessionEpoch).toBe(3) // BigInt serialized as a JSON number
    expect(row1.maxAgents).toBe(5)
    expect(body.find((d) => d.daemonId === d2)!.status).toBe('offline') // seeded but not connected
  })

  it('admits requests via the devAuth stub (no OIDC_ISSUER) — principal attached, no 401', async () => {
    const app = build()
    // /daemons is an authed route; the devAuth stub must let it through.
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/daemons` })
    expect(res.statusCode).toBe(200)
  })

  it('POST /agents then GET /agents/:id round-trips through the real repo', async () => {
    const app = build()
    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'router-bot', runtime: 'claude', capabilities: ['fs.read', 'fs.write'] }
    })
    expect(create.statusCode).toBe(201)
    const created = create.json() as {
      id: string
      name: string
      runtime: string
      status: string
      createdBy: string | null
      createdAt: string
      lastModifiedBy: string | null
      lastModifiedAt: string
      callPolicy: string
      allowedCallerAgentIds: string[]
      outboundPolicy: string
      allowedTargetAgentIds: string[]
    }
    expect(created.id).toMatch(/[0-9a-f-]{36}/)
    expect(created.name).toBe('router-bot')
    expect(created.runtime).toBe('claude')
    // Creator captured from the devAuth principal (seeded owner); the DTO surfaces the
    // userId, which the web resolves to a display name (or "You" for the viewer).
    expect(created.createdBy).toBe('usr_owner000000000000000000')
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false)
    expect(created.lastModifiedBy).toBe(created.createdBy)
    expect(created.lastModifiedAt).toBe(created.createdAt)
    expect(created.callPolicy).toBe('all')
    expect(created.allowedCallerAgentIds).toEqual([])
    expect(created.outboundPolicy).toBe('all')
    expect(created.allowedTargetAgentIds).toEqual([])

    // Persisted in the real DB — the FK points at the seeded owner user.
    const row = await prisma.agent.findUnique({ where: { id: created.id } })
    expect(row?.name).toBe('router-bot')
    expect(row?.capabilities).toEqual(['fs.read', 'fs.write'])
    expect(row?.createdByUserId).toBeTruthy()
    // Last-modified audit captured at create: editor == creator, stamped at createdAt.
    expect(row?.lastModifiedByUserId).toBe(row?.createdByUserId)
    expect(row?.lastModifiedAt).toEqual(row?.createdAt)

    // GET round-trips the same record through the repo.
    const get = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${created.id}` })
    expect(get.statusCode).toBe(200)
    const fetched = get.json() as {
      id: string
      name: string
      capabilities: string[]
      lastModifiedBy: string | null
      lastModifiedAt: string
      callPolicy: string
      allowedCallerAgentIds: string[]
      outboundPolicy: string
      allowedTargetAgentIds: string[]
    }
    expect(fetched.id).toBe(created.id)
    expect(fetched.name).toBe('router-bot')
    expect(fetched.capabilities).toEqual(['fs.read', 'fs.write'])
    expect(fetched.lastModifiedBy).toBe(created.lastModifiedBy)
    expect(fetched.lastModifiedAt).toBe(created.lastModifiedAt)
    expect(fetched.callPolicy).toBe('all')
    expect(fetched.allowedCallerAgentIds).toEqual([])
    expect(fetched.outboundPolicy).toBe('all')
    expect(fetched.allowedTargetAgentIds).toEqual([])
  })

  it('defaults and locks Run in sandbox from the placed daemon policy', async () => {
    const app = build()
    const unsupportedId = randomUUID()
    const optionalId = randomUUID()
    const requiredId = randomUUID()
    const capabilities = (features: string[]) => ({ platforms: [], runtimes: ['claude'], acp: true, features })
    await seedDaemon(prisma, unsupportedId, { capabilities: capabilities([]) })
    await seedDaemon(prisma, optionalId, { capabilities: capabilities(['sandbox']) })
    await seedDaemon(prisma, requiredId, {
      capabilities: capabilities(['sandbox', 'sandbox-required'])
    })

    const unsupported = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'unsandboxed', runtime: 'claude', daemonId: unsupportedId }
    })
    expect(unsupported.statusCode).toBe(201)
    expect(unsupported.json()).toMatchObject({
      runInSandbox: false,
      sandboxSupported: false,
      sandboxRequired: false
    })

    const optional = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'optional-sandbox', runtime: 'claude', daemonId: optionalId }
    })
    expect(optional.statusCode).toBe(201)
    const optionalBody = optional.json() as { id: string }
    expect(optional.json()).toMatchObject({
      runInSandbox: false,
      sandboxSupported: true,
      sandboxRequired: false
    })

    const enable = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${optionalBody.id}`,
      payload: { runInSandbox: true }
    })
    expect(enable.statusCode).toBe(200)
    expect(enable.json()).toMatchObject({ runInSandbox: true })

    const required = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'required-sandbox', runtime: 'claude', daemonId: requiredId }
    })
    expect(required.statusCode).toBe(201)
    const requiredBody = required.json() as { id: string }
    expect(required.json()).toMatchObject({
      runInSandbox: true,
      sandboxSupported: true,
      sandboxRequired: true
    })

    const disable = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${requiredBody.id}`,
      payload: { runInSandbox: false }
    })
    expect(disable.statusCode).toBe(409)
    expect(disable.json()).toMatchObject({ message: 'Run in sandbox is required by this daemon' })
  })

  it('PUT /agents/:id/call-policy stores selected peer agents and clears the list for all', async () => {
    const app = build()
    const targetId = randomUUID()
    const callerId = randomUUID()
    const caller2Id = randomUUID()
    const foreignOrgId = 'org_agent_call_policy_other'
    const foreignCallerId = randomUUID()
    await seedAgent(prisma, targetId, { name: 'deploy-bot' })
    await seedAgent(prisma, callerId, { name: 'review-bot' })
    await seedAgent(prisma, caller2Id, { name: 'docs-bot' })
    await prisma.org.create({ data: { id: foreignOrgId, slug: `foreign-${foreignCallerId.slice(0, 8)}` } })
    await prisma.agent.create({
      data: { id: foreignCallerId, orgId: foreignOrgId, name: 'foreign-bot', runtime: 'claude' }
    })

    const selected = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${targetId}/call-policy`,
      payload: {
        callPolicy: 'selected',
        allowedCallerAgentIds: [callerId, targetId, foreignCallerId, callerId],
        outboundPolicy: 'selected',
        allowedTargetAgentIds: [caller2Id, targetId, foreignCallerId, caller2Id]
      }
    })

    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toMatchObject({
      id: targetId,
      callPolicy: 'selected',
      allowedCallerAgentIds: [callerId],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [caller2Id]
    })
    let row = await prisma.agent.findUnique({ where: { id: targetId } })
    expect(row?.callPolicy).toBe('selected')
    expect(row?.allowedCallerAgentIds).toEqual([callerId])
    expect(row?.outboundPolicy).toBe('selected')
    expect(row?.allowedTargetAgentIds).toEqual([caller2Id])

    // A pre-outbound-policy client editing only the inbound half must not reset
    // an outbound restriction it does not know how to represent.
    const legacyInboundEdit = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${targetId}/call-policy`,
      payload: { callPolicy: 'all', allowedCallerAgentIds: [] }
    })
    expect(legacyInboundEdit.statusCode).toBe(200)
    expect(legacyInboundEdit.json()).toMatchObject({
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [caller2Id]
    })

    const all = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${targetId}/call-policy`,
      payload: {
        callPolicy: 'all',
        allowedCallerAgentIds: [caller2Id],
        outboundPolicy: 'all',
        allowedTargetAgentIds: [callerId]
      }
    })

    expect(all.statusCode).toBe(200)
    expect(all.json()).toMatchObject({
      id: targetId,
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: []
    })
    row = await prisma.agent.findUnique({ where: { id: targetId } })
    expect(row?.callPolicy).toBe('all')
    expect(row?.allowedCallerAgentIds).toEqual([])
    expect(row?.outboundPolicy).toBe('all')
    expect(row?.allowedTargetAgentIds).toEqual([])
  })

  it('POST /agents accepts a selected call policy at create, intersecting the allow-list with visible peers', async () => {
    const app = build()
    const callerId = randomUUID()
    const foreignOrgId = 'org_agent_create_policy_other'
    const foreignCallerId = randomUUID()
    await seedAgent(prisma, callerId, { name: 'review-bot' })
    await prisma.org.create({ data: { id: foreignOrgId, slug: `foreign-${foreignCallerId.slice(0, 8)}` } })
    await prisma.agent.create({
      data: { id: foreignCallerId, orgId: foreignOrgId, name: 'foreign-bot', runtime: 'claude' }
    })

    // A cross-org peer and duplicates are dropped in BOTH directions; only the
    // visible same-org peer survives. Both halves must reach the row — a create
    // that accepted the outbound half but never persisted it would silently leave
    // the agent able to call everyone.
    const selected = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'deploy-bot',
        runtime: 'claude',
        callPolicy: 'selected',
        allowedCallerAgentIds: [callerId, foreignCallerId, callerId],
        outboundPolicy: 'selected',
        allowedTargetAgentIds: [callerId, foreignCallerId, callerId]
      }
    })
    expect(selected.statusCode).toBe(201)
    expect(selected.json()).toMatchObject({
      callPolicy: 'selected',
      allowedCallerAgentIds: [callerId],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [callerId]
    })
    const selectedId = (selected.json() as { id: string }).id
    const selectedRow = await prisma.agent.findUnique({ where: { id: selectedId } })
    expect(selectedRow?.callPolicy).toBe('selected')
    expect(selectedRow?.allowedCallerAgentIds).toEqual([callerId])
    expect(selectedRow?.outboundPolicy).toBe('selected')
    expect(selectedRow?.allowedTargetAgentIds).toEqual([callerId])

    // The halves are independent: restricting only the outbound side leaves the
    // inbound side at the organization default.
    const outboundOnly = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'triage-bot',
        runtime: 'claude',
        outboundPolicy: 'selected',
        allowedTargetAgentIds: [callerId]
      }
    })
    expect(outboundOnly.statusCode).toBe(201)
    expect(outboundOnly.json()).toMatchObject({
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [callerId]
    })
    const outboundOnlyRow = await prisma.agent.findUnique({
      where: { id: (outboundOnly.json() as { id: string }).id }
    })
    expect(outboundOnlyRow?.outboundPolicy).toBe('selected')
    expect(outboundOnlyRow?.allowedTargetAgentIds).toEqual([callerId])

    // Omitting the policy uses the organization default in both directions.
    const dflt = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'docs-bot', runtime: 'claude' }
    })
    expect(dflt.statusCode).toBe(201)
    expect(dflt.json()).toMatchObject({
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: []
    })
  })

  it('DELETE /agents/:id cascades agent-owned hooks and secrets but preserves run history', async () => {
    const app = build()
    const agentId = randomUUID()
    const hookId = randomUUID()
    await seedAgent(prisma, agentId)
    await prisma.hookDef.create({
      data: {
        id: hookId,
        orgId: DEFAULT_ORG_ID,
        agentId,
        kind: 'webhook',
        name: 'delete-me',
        sessionMode: 'perDelivery',
        urlToken: `whk_${randomUUID().replaceAll('-', '')}`
      }
    })
    await prisma.hookSecret.create({ data: { hookId, hmacSecret: 'whsec_test' } })
    await prisma.hookRun.create({
      data: {
        hookId,
        orgId: DEFAULT_ORG_ID,
        deliveryKey: 'delivery-1',
        startedAt: new Date('2026-07-08T10:00:00Z')
      }
    })

    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` })

    expect(del.statusCode).toBe(204)
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toBeNull()
    expect(await prisma.hookDef.findUnique({ where: { id: hookId } })).toBeNull()
    expect(await prisma.hookSecret.findUnique({ where: { hookId } })).toBeNull()
    expect(await prisma.hookRun.findMany({ where: { hookId } })).toEqual([
      expect.objectContaining({ hookId, orgId: DEFAULT_ORG_ID, deliveryKey: 'delivery-1' })
    ])
  })

  it('POST /agents accepts model + daemonId + a github workspace (inline, returned on the DTO)', async () => {
    const app = build()
    const daemonId = 'a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await seedDaemon(prisma, daemonId)

    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'deploy-bot',
        runtime: 'claude',
        model: 'opus',
        daemonId,
        workspace: { mode: 'github', gitRepo: 'github.com/acme/infra', agentDir: './services/api' }
      }
    })
    expect(create.statusCode).toBe(201)
    const created = create.json() as {
      id: string
      model: string | null
      daemonId: string | null
      status: string
      workspace: { mode: string; worktree?: boolean; gitRepo?: string; gitBranch?: string; agentDir?: string }
    }
    expect(created.model).toBe('opus')
    expect(created.daemonId).toBe(daemonId) // placed on the chosen daemon
    expect(created.status).toBe('active')
    // shorthand input is normalized to the full cloneable address at the DTO boundary
    expect(created.workspace).toEqual({
      mode: 'github',
      worktree: true,
      gitRepo: 'https://github.com/acme/infra',
      gitBranch: 'main',
      agentDir: 'services/api'
    })

    // Persisted inline on the agent row (no separate workspace entity), full address.
    const row = await prisma.agent.findUnique({ where: { id: created.id } })
    expect(row?.workspaceMode).toBe('github')
    expect(row?.workspaceIsolation).toBe('session')
    expect(row?.gitRepo).toBe('https://github.com/acme/infra')
    expect(row?.agentDir).toBe('services/api')
    expect((row?.runtimeOverrides as { model: string }).model).toBe('opus')

    // A plain POST (no workspace) defaults to scratch.
    const scratch = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'fresh-bot', runtime: 'claude' }
    })
    expect((scratch.json() as { workspace: { mode: string } }).workspace).toEqual({ mode: 'scratch' })
  })

  it('POST /agents rejects unsafe and credential-bearing clone targets without persisting or echoing secrets', async () => {
    const app = build()
    const rejected = [
      'http://github.com/acme/infra',
      'file:///tmp/infra',
      'git://github.com/acme/infra',
      'ftp://example.com/acme/infra',
      'ext::sh -c harmless'
    ]

    for (const [index, gitRepo] of rejected.entries()) {
      const name = `unsafe-repo-${index}`
      const response = await app.app.inject({
        method: 'POST',
        url: `${ORG}/agents`,
        payload: { name, runtime: 'claude', workspace: { mode: 'github', gitRepo } }
      })
      expect(response.statusCode).toBe(400)
      expect(await prisma.agent.findFirst({ where: { name } })).toBeNull()
    }

    const secret = 'super-secret-pat'
    const credentialName = 'credential-repo'
    const credential = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: credentialName,
        runtime: 'claude',
        workspace: {
          mode: 'github',
          gitRepo: `https://alice:${secret}@github.com/acme/infra?token=query-secret#fragment`
        }
      }
    })
    expect(credential.statusCode).toBe(400)
    expect(credential.body).not.toContain(secret)
    expect(credential.body).not.toContain('query-secret')
    expect(await prisma.agent.findFirst({ where: { name: credentialName } })).toBeNull()

    const ambiguousSecret = 'ambiguous-secret'
    const ambiguousName = 'ambiguous-authority-repo'
    const ambiguous = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: ambiguousName,
        runtime: 'claude',
        workspace: {
          mode: 'github',
          gitRepo: `https://good.example\\alice:${ambiguousSecret}@127.0.0.1/acme/infra`
        }
      }
    })
    expect(ambiguous.statusCode).toBe(400)
    expect(ambiguous.body).not.toContain(ambiguousSecret)
    expect(await prisma.agent.findFirst({ where: { name: ambiguousName } })).toBeNull()
  })

  it('validates, updates, and clears a GitHub working subdirectory', async () => {
    const app = build()
    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'monorepo-bot',
        runtime: 'claude',
        workspace: { mode: 'github', gitRepo: 'acme/monorepo', agentDir: 'apps/web' }
      }
    })
    expect(create.statusCode).toBe(201)
    const agentId = (create.json() as { id: string }).id

    const update = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { agentDir: './services/api' }
    })
    expect(update.statusCode).toBe(200)
    expect((update.json() as { workspace: { agentDir?: string } }).workspace.agentDir).toBe('services/api')
    expect((await prisma.agent.findUnique({ where: { id: agentId } }))?.agentDir).toBe('services/api')

    const clear = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { agentDir: null }
    })
    expect(clear.statusCode).toBe(200)
    expect((clear.json() as { workspace: { agentDir?: string } }).workspace.agentDir).toBeUndefined()
    expect((await prisma.agent.findUnique({ where: { id: agentId } }))?.agentDir).toBeNull()
  })

  it('rejects unsafe working subdirectories and rejects the field for scratch workspaces', async () => {
    const app = build()
    const invalid = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'unsafe-bot',
        runtime: 'claude',
        workspace: { mode: 'github', gitRepo: 'acme/monorepo', agentDir: '../outside' }
      }
    })
    expect(invalid.statusCode).toBe(400)

    const scratch = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'scratch-dir-bot', runtime: 'claude' }
    })
    const scratchId = (scratch.json() as { id: string }).id
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${scratchId}`,
      payload: { agentDir: 'services/api' }
    })
    expect(patch.statusCode).toBe(409)
  })

  it('keeps historical invalid agentDir values readable', async () => {
    const app = build()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { gitRepo: 'https://github.com/acme/legacy' })
    await prisma.agent.update({ where: { id: agentId }, data: { agentDir: '../legacy-outside' } })

    const get = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })

    expect(get.statusCode).toBe(200)
    expect((get.json() as { workspace: { agentDir?: string } }).workspace.agentDir).toBe('../legacy-outside')
  })

  it('keeps a historical credential-bearing gitRepo readable without returning its secrets', async () => {
    const app = build()
    const agentId = randomUUID()
    const missingRepoAgentId = randomUUID()
    const stored = 'https://legacy-user:legacy-password@github.com/acme/legacy.git?access_token=query-secret#fragment'
    await seedAgent(prisma, agentId, { gitRepo: stored })
    await seedAgent(prisma, missingRepoAgentId)
    await prisma.agent.update({
      where: { id: missingRepoAgentId },
      data: { workspaceMode: 'github', gitRepo: null }
    })

    const get = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })
    const getMissing = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${missingRepoAgentId}` })

    expect(get.statusCode).toBe(200)
    expect(get.body).not.toContain('legacy-user')
    expect(get.body).not.toContain('legacy-password')
    expect(get.body).not.toContain('query-secret')
    expect((get.json() as { workspace: { gitRepo: string } }).workspace.gitRepo).toBe(
      'https://github.com/acme/legacy.git'
    )
    // Read sanitization is compatibility protection, not an implicit write.
    expect((await prisma.agent.findUnique({ where: { id: agentId } }))?.gitRepo).toBe(stored)
    expect(getMissing.statusCode).toBe(200)
    expect((getMissing.json() as { workspace: { gitRepo: string } }).workspace.gitRepo).toBe('')
  })

  it('POST /agents rejects write access for anonymous GitHub workspaces', async () => {
    const app = build()

    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'public-write-bot',
        runtime: 'claude',
        workspace: { mode: 'github', gitRepo: 'github.com/acme/infra', gitAccess: 'write' }
      }
    })

    expect(create.statusCode).toBe(409)
    expect(create.json()).toMatchObject({
      message: 'github write access requires a GitHub App installation'
    })
  })

  it('name must be a slug; displayName carries the original; duplicate name in an org → 409', async () => {
    const app = build()

    // A non-slug name is rejected (400).
    const bad = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'Acme Network Bot', runtime: 'claude' }
    })
    expect(bad.statusCode).toBe(400)

    // The slug + displayName round-trip.
    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'acme-network-bot', displayName: 'Acme Network Bot', runtime: 'claude' }
    })
    expect(create.statusCode).toBe(201)
    const created = create.json() as { id: string; name: string; displayName: string | null }
    expect(created.name).toBe('acme-network-bot')
    expect(created.displayName).toBe('Acme Network Bot')

    // Same slug in the same org → 409 conflict.
    const dup = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'acme-network-bot', runtime: 'claude' }
    })
    expect(dup.statusCode).toBe(409)

    // PATCH can edit displayName, but the slug (name) is IMMUTABLE — sending it → 400.
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { displayName: 'Acme Bot' }
    })
    expect(patch.statusCode).toBe(200)
    const patched = patch.json() as { name: string; displayName: string | null }
    expect(patched.name).toBe('acme-network-bot') // unchanged
    expect(patched.displayName).toBe('Acme Bot')

    // Any attempt to rename the slug is rejected (even a valid slug value).
    const renameSlug = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { name: 'acme-bot' }
    })
    expect(renameSlug.statusCode).toBe(400)
  })

  it('POST + PATCH /agents carries the description (system prompt) and clears it with null', async () => {
    const app = build()
    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'helper', runtime: 'claude', description: 'You are a backend helper.' }
    })
    expect(create.statusCode).toBe(201)
    const created = create.json() as { id: string; description: string | null }
    expect(created.description).toBe('You are a backend helper.')
    expect((await prisma.agent.findUnique({ where: { id: created.id } }))?.description).toBe(
      'You are a backend helper.'
    )

    // PATCH edits displayName + prompt (the slug `name` is immutable)
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { displayName: 'Helper 2', description: 'Now you review PRs.' }
    })
    expect(patch.statusCode).toBe(200)
    const patched = patch.json() as { displayName: string | null; description: string | null }
    expect(patched.displayName).toBe('Helper 2')
    expect(patched.description).toBe('Now you review PRs.')

    // null clears the prompt; 404 for unknown id
    const cleared = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { description: null }
    })
    expect((cleared.json() as { description: string | null }).description).toBeNull()
    const miss = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${randomUUID()}`,
      payload: { description: 'x' }
    })
    expect(miss.statusCode).toBe(404)
  })

  it('POST + PATCH /agents round-trips the pause flag and clears it with null (#288)', async () => {
    const app = build()
    // Create paused; GET reflects it and the flag lands in the overrides JSON.
    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'pausable', runtime: 'claude', pause: true }
    })
    expect(create.statusCode).toBe(201)
    const created = create.json() as { id: string; pause: boolean | null }
    expect(created.pause).toBe(true)

    const get = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${created.id}` })
    expect((get.json() as { pause: boolean | null }).pause).toBe(true)

    // PATCH false ⇒ unpaused (kept, not cleared).
    const off = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { pause: false }
    })
    expect((off.json() as { pause: boolean | null }).pause).toBe(false)

    // PATCH null ⇒ the override key is removed entirely (back to "never set").
    const cleared = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { pause: null }
    })
    expect((cleared.json() as { pause: boolean | null }).pause).toBeNull()
  })

  it('PATCH /agents advances the last-modified audit (who + when) without touching the creator', async () => {
    const app = build()
    const created = (
      await app.app.inject({ method: 'POST', url: `${ORG}/agents`, payload: { name: 'audited', runtime: 'claude' } })
    ).json() as { id: string }
    const before = await prisma.agent.findUnique({ where: { id: created.id } })

    // Bracket the edit with a same-process (Node) timestamp: the repo stamps
    // lastModifiedAt with `new Date()` in THIS process, so `>= t0` proves it was
    // freshly re-stamped — without comparing across the Node vs Postgres clocks
    // (the DB-sourced createdAt/before values live on the container clock).
    const t0 = Date.now()
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { displayName: 'Audited Bot' }
    })
    expect(patch.statusCode).toBe(200)
    const patched = patch.json() as {
      createdBy: string | null
      lastModifiedBy: string | null
      lastModifiedAt: string
    }
    expect(patched.lastModifiedBy).toBe(patched.createdBy)
    expect(Date.parse(patched.lastModifiedAt)).not.toBeNaN()

    const after = await prisma.agent.findUnique({ where: { id: created.id } })
    // Creator is never reassigned by an edit; the last-modified pair advances.
    expect(after?.createdByUserId).toBe(before?.createdByUserId)
    expect(after?.createdAt).toEqual(before?.createdAt)
    expect(after?.lastModifiedByUserId).toBe(before?.createdByUserId) // devAuth owner did the edit
    expect(after!.lastModifiedAt.getTime()).toBeGreaterThanOrEqual(t0) // re-stamped at edit time
  })

  it('PATCH /agents also updates model, runtime, and capabilities', async () => {
    const app = build()
    const created = (
      await app.app.inject({ method: 'POST', url: `${ORG}/agents`, payload: { name: 'r', runtime: 'claude' } })
    ).json() as { id: string }

    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { model: 'opus', runtime: 'codex', capabilities: ['fs.read', 'fs.write'] }
    })
    expect(patch.statusCode).toBe(200)
    const p = patch.json() as { model: string; runtime: string; capabilities: string[] }
    expect(p.model).toBe('opus')
    expect(p.runtime).toBe('codex')
    expect(p.capabilities).toEqual(['fs.read', 'fs.write'])

    const row = await prisma.agent.findUnique({ where: { id: created.id } })
    expect(row?.runtime).toBe('codex')
    expect((row?.runtimeOverrides as { model: string }).model).toBe('opus')
    expect(row?.capabilities).toEqual(['fs.read', 'fs.write'])

    // empty patch is rejected
    const bad = await app.app.inject({ method: 'PATCH', url: `${ORG}/agents/${created.id}`, payload: {} })
    expect(bad.statusCode).toBe(400)
  })

  it('POST + PATCH /agents carries reasoningEffort + env; the JSON merge never clobbers siblings', async () => {
    const app = build()
    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'tuned',
        runtime: 'claude',
        model: 'opus',
        reasoningEffort: 'high',
        env: { GITHUB_TOKEN: 'ghp_x', DEPLOY_ENV: 'production' }
      }
    })
    expect(create.statusCode).toBe(201)
    const created = create.json() as { id: string; reasoningEffort: string | null; env: Record<string, string> }
    expect(created.reasoningEffort).toBe('high')
    expect(created.env).toEqual({ GITHUB_TOKEN: 'ghp_x', DEPLOY_ENV: 'production' })

    // All three live side by side in the runtimeOverrides JSON.
    const row = await prisma.agent.findUnique({ where: { id: created.id } })
    expect(row?.runtimeOverrides).toEqual({
      model: 'opus',
      reasoningEffort: 'high',
      env: { GITHUB_TOKEN: 'ghp_x', DEPLOY_ENV: 'production' }
    })

    // Patching env alone leaves model + reasoningEffort untouched.
    const envPatch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { env: { GITHUB_TOKEN: 'ghp_y' } }
    })
    expect(envPatch.statusCode).toBe(200)
    const afterEnv = envPatch.json() as {
      model: string | null
      reasoningEffort: string | null
      env: Record<string, string>
    }
    expect(afterEnv.model).toBe('opus')
    expect(afterEnv.reasoningEffort).toBe('high')
    expect(afterEnv.env).toEqual({ GITHUB_TOKEN: 'ghp_y' }) // replaced wholesale, not merged

    // null deletes just its key; {} empties env without touching the others.
    const clearEffort = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { reasoningEffort: null, env: {} }
    })
    const cleared = clearEffort.json() as {
      model: string | null
      reasoningEffort: string | null
      env: Record<string, string>
    }
    expect(cleared.reasoningEffort).toBeNull()
    expect(cleared.env).toEqual({})
    expect(cleared.model).toBe('opus')
    expect((await prisma.agent.findUnique({ where: { id: created.id } }))?.runtimeOverrides).toEqual({
      model: 'opus',
      env: {}
    })

    // env keys must be legal environment-variable names.
    const badKey = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { env: { 'no spaces': 'x' } }
    })
    expect(badKey.statusCode).toBe(400)
  })

  it('POST + PATCH /agents manages write-only secrets — DTO exposes only key names', async () => {
    const app = build()
    // Create with an initial secret set alongside a plain env var.
    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'secret-bot',
        runtime: 'claude',
        env: { PUBLIC_URL: 'https://x' },
        secrets: { API_KEY: 'sk-1', DB_PASSWORD: 'p@ss' }
      }
    })
    expect(create.statusCode).toBe(201)
    const created = create.json() as { id: string; env: Record<string, string>; secretKeys: string[] }
    // The DTO carries only the sorted key NAMES — never the values.
    expect(created.secretKeys).toEqual(['API_KEY', 'DB_PASSWORD'])
    expect(created.env).toEqual({ PUBLIC_URL: 'https://x' })
    expect(JSON.stringify(created)).not.toContain('sk-1')
    expect(JSON.stringify(created)).not.toContain('p@ss')

    // Values are persisted row-per-key in agent_secret behind the AgentSecretStore
    // seam — NEVER in the agent row's runtimeOverrides bag, never a response.
    const row = await prisma.agent.findUnique({ where: { id: created.id } })
    expect(row?.runtimeOverrides).toEqual({ env: { PUBLIC_URL: 'https://x' } })
    const secretRows = await prisma.agentSecret.findMany({ where: { agentId: created.id }, orderBy: { key: 'asc' } })
    expect(secretRows.map((s) => ({ key: s.key, value: s.value }))).toEqual([
      { key: 'API_KEY', value: 'sk-1' },
      { key: 'DB_PASSWORD', value: 'p@ss' }
    ])

    // PATCH merges key-by-key: replace API_KEY, add SLACK_TOKEN, delete DB_PASSWORD
    // (null), and leave the plain env var untouched.
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { secrets: { API_KEY: 'sk-2', SLACK_TOKEN: 'xoxb', DB_PASSWORD: null } }
    })
    expect(patch.statusCode).toBe(200)
    expect((patch.json() as { secretKeys: string[] }).secretKeys).toEqual(['API_KEY', 'SLACK_TOKEN'])
    const secretRows2 = await prisma.agentSecret.findMany({ where: { agentId: created.id }, orderBy: { key: 'asc' } })
    expect(secretRows2.map((s) => ({ key: s.key, value: s.value }))).toEqual([
      { key: 'API_KEY', value: 'sk-2' },
      { key: 'SLACK_TOKEN', value: 'xoxb' }
    ])
    const row2 = await prisma.agent.findUnique({ where: { id: created.id } })
    expect((row2?.runtimeOverrides as { env?: Record<string, string> }).env).toEqual({ PUBLIC_URL: 'https://x' })

    // Deleting the last secret leaves no rows behind.
    const clear = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { secrets: { API_KEY: null, SLACK_TOKEN: null } }
    })
    expect(clear.statusCode).toBe(200)
    expect((clear.json() as { secretKeys: string[] }).secretKeys).toEqual([])
    expect(await prisma.agentSecret.count({ where: { agentId: created.id } })).toBe(0)

    // Secret keys must be legal environment-variable names.
    const badKey = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { secrets: { 'no spaces': 'x' } }
    })
    expect(badKey.statusCode).toBe(400)
  })

  it('POST + PATCH /agents carries output and chat runtime controls in runtimeOverrides', async () => {
    const app = build()
    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'verbose',
        runtime: 'codex',
        outputMode: 'high',
        showFooter: false,
        showStatusBar: false,
        fastMode: true,
        allowRuntimeChangesInChat: true
      }
    })
    expect(create.statusCode).toBe(201)
    const created = create.json() as {
      id: string
      outputMode: string | null
      showFooter: boolean
      showStatusBar: boolean
      fastMode: boolean | null
      allowRuntimeChangesInChat: boolean
    }
    expect(created.outputMode).toBe('high')
    expect(created.showFooter).toBe(false)
    expect(created.showStatusBar).toBe(false)
    expect(created.fastMode).toBe(true)
    expect(created.allowRuntimeChangesInChat).toBe(true)
    expect((await prisma.agent.findUnique({ where: { id: created.id } }))?.runtimeOverrides).toEqual({
      outputMode: 'high',
      showFooter: false,
      showStatusBar: false,
      fastMode: true,
      allowRuntimeChangesInChat: true
    })

    // Explicit false/true booleans persist; nullable runtime selectors can still be cleared.
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: {
        outputMode: 'low',
        showFooter: true,
        showStatusBar: true,
        fastMode: false,
        allowRuntimeChangesInChat: false
      }
    })
    expect(patch.statusCode).toBe(200)
    const patched = patch.json() as {
      outputMode: string | null
      showFooter: boolean
      showStatusBar: boolean
      fastMode: boolean | null
      allowRuntimeChangesInChat: boolean
    }
    expect(patched.outputMode).toBe('low')
    expect(patched.showFooter).toBe(true)
    expect(patched.showStatusBar).toBe(true)
    expect(patched.fastMode).toBe(false)
    expect(patched.allowRuntimeChangesInChat).toBe(false)

    const cleared = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { outputMode: null, fastMode: null }
    })
    expect((cleared.json() as { outputMode: string | null }).outputMode).toBeNull()
    expect((cleared.json() as { fastMode: boolean | null }).fastMode).toBeNull()
    expect((await prisma.agent.findUnique({ where: { id: created.id } }))?.runtimeOverrides).toEqual({
      showFooter: true,
      showStatusBar: true,
      allowRuntimeChangesInChat: false
    })

    // outputMode vocabulary is closed — anything else is a 400.
    const bad = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { outputMode: 'verbose' }
    })
    expect(bad.statusCode).toBe(400)
  })

  it('proxies the editor approval queue to the agent’s owning daemon', async () => {
    const daemonId = randomUUID()
    const agentId = randomUUID()
    const requestId = randomUUID()
    await seedDaemon(prisma, daemonId)
    await seedAgent(prisma, agentId, { daemonId })

    const agentPermissionRequests = vi.fn(async () => ({
      agentId,
      requests: [
        {
          id: requestId,
          agentId,
          sessionId: 'session-1',
          createdAt: new Date(100).toISOString(),
          requesterId: 'user-1',
          requesterName: 'Ada',
          command: 'Bash: pnpm test',
          status: 'pending' as const,
          resolvedAt: null
        }
      ]
    }))
    const agentPermissionDecision = vi.fn(async () => ({ ok: true as const }))
    const control = { agentPermissionRequests, agentPermissionDecision } as unknown as ControlSender
    running = buildHttpApp(prisma, undefined, undefined, control)

    const listed = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${agentId}/permission-requests`
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toEqual({
      requests: [
        expect.objectContaining({
          id: requestId,
          sessionId: 'session-1',
          requesterName: 'Ada',
          command: 'Bash: pnpm test',
          status: 'pending'
        })
      ]
    })
    expect(agentPermissionRequests).toHaveBeenCalledWith(daemonId, { agentId, limit: 100 })

    const decided = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${agentId}/permission-requests/${requestId}/decision`,
      payload: { decision: 'deny' }
    })
    expect(decided.statusCode).toBe(200)
    expect(agentPermissionDecision).toHaveBeenCalledWith(daemonId, {
      agentId,
      requestId,
      decision: 'deny'
    })
  })

  it('POST + PATCH /agents carries mcpServers in the runtimeOverrides JSON; null clears to []', async () => {
    const app = build()
    const create = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'tooled', runtime: 'claude', mcpServers: ['github', 'metrics'] }
    })
    expect(create.statusCode).toBe(201)
    const created = create.json() as { id: string; mcpServers: string[] }
    expect(created.mcpServers).toEqual(['github', 'metrics'])
    expect((await prisma.agent.findUnique({ where: { id: created.id } }))?.runtimeOverrides).toEqual({
      mcpServers: ['github', 'metrics']
    })

    // Replaced wholesale; siblings in the overrides JSON stay untouched.
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { model: 'opus', mcpServers: ['metrics'] }
    })
    expect(patch.statusCode).toBe(200)
    const patched = patch.json() as { model: string | null; mcpServers: string[] }
    expect(patched.model).toBe('opus')
    expect(patched.mcpServers).toEqual(['metrics'])

    // null deletes just its key; the read defaults back to [] (none attached).
    const cleared = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${created.id}`,
      payload: { mcpServers: null }
    })
    expect((cleared.json() as { mcpServers: string[] }).mcpServers).toEqual([])
    expect((await prisma.agent.findUnique({ where: { id: created.id } }))?.runtimeOverrides).toEqual({
      model: 'opus'
    })

    // An agent created without the field reads [] (never undefined/null).
    const plain = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'plain', runtime: 'claude' }
    })
    expect((plain.json() as { mcpServers: string[] }).mcpServers).toEqual([])
  })

  it("GET /agents lists the org's agents; GET /agents/:id 404s for an unknown id", async () => {
    const app = build()
    await app.app.inject({ method: 'POST', url: `${ORG}/agents`, payload: { name: 'a', runtime: 'claude' } })
    await app.app.inject({ method: 'POST', url: `${ORG}/agents`, payload: { name: 'b', runtime: 'codex' } })

    const list = await app.app.inject({ method: 'GET', url: `${ORG}/agents` })
    expect(list.statusCode).toBe(200)
    expect((list.json() as unknown[]).length).toBe(2)

    const miss = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${randomUUID()}` })
    expect(miss.statusCode).toBe(404)
  })

  it('PUT /crons (upsert) → GET /crons → DELETE round-trips through the real repo', async () => {
    const app = build()
    const cronId = randomUUID()
    const cronAgentId = randomUUID()
    await seedAgent(prisma, cronAgentId)
    const put = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: {
        agentId: cronAgentId,
        schedule: '0 9 * * 1',
        targetPlatform: 'slack',
        targetChannel: '#standup',
        trigger: 'post the standup',
        enabled: true
      }
    })
    expect(put.statusCode).toBe(200)
    const cron = put.json() as { id: string; schedule: string; targetChannel: string; enabled: boolean }
    expect(cron.id).toBe(cronId)
    expect(cron.schedule).toBe('0 9 * * 1')
    expect(cron.targetChannel).toBe('#standup')

    const row = await prisma.cronDef.findUnique({ where: { id: cronId } })
    expect(row?.targetChannel).toBe('#standup')

    const list = await app.app.inject({ method: 'GET', url: `${ORG}/crons` })
    expect(list.statusCode).toBe(200)
    expect((list.json() as unknown[]).length).toBe(1)

    // Re-PUT is idempotent (upsert): updates, does not duplicate.
    const put2 = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: {
        agentId: cronAgentId,
        schedule: '0 10 * * 1',
        targetChannel: '#standup',
        trigger: 'post the standup',
        enabled: false
      }
    })
    expect(put2.statusCode).toBe(200)
    expect((put2.json() as { enabled: boolean }).enabled).toBe(false)
    const after = await app.app.inject({ method: 'GET', url: `${ORG}/crons` })
    expect((after.json() as unknown[]).length).toBe(1)

    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/crons/${cronId}` })
    expect(del.statusCode).toBe(204)
    expect(await prisma.cronDef.findUnique({ where: { id: cronId } })).toBeNull()
  })

  it('GET /health is served from the http server and needs no auth', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
