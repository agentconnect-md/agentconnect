/**
 * Agent-config replication CP→daemon over the C2 REST surface.
 *
 * AgentConnect differs from a portal-only model: Slack connects directly to the
 * daemon, which can start an agent autonomously (CP off the hot path). So the
 * daemon must hold a local replica of every agent's config. The CP keeps that
 * replica current by pushing `agent/upsert` (add/change) and `agent/remove`
 * (delete) to the agent's owning daemon whenever its definition mutates over REST.
 *
 * Here we drive POST/PATCH/DELETE `/agents` through `app.inject` with a spy
 * `ControlSender` and assert the emitted frames. Emit is best-effort and keyed on
 * placement: an unplaced agent (no `daemonId`) pushes nothing — the `register/ok`
 * reconcile roster is the backstop — and a `NoConnection` from an offline daemon
 * never fails the request.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { ControlSender, NoConnection } from '../../src/orchestrator/outbound.js'
import type { AgentUpsert, AgentRemove, CollabRoutesSnapshot } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** A ControlSender spy that records the upsert/remove pushes the route makes. */
class SpyControl {
  readonly upserts: Array<{ daemonId: string; u: AgentUpsert }> = []
  readonly removes: Array<{ daemonId: string; r: AgentRemove }> = []
  readonly collaboration: Array<{ daemonId: string; snapshot: CollabRoutesSnapshot }> = []
  async agentUpsert(daemonId: string, u: AgentUpsert): Promise<void> {
    this.upserts.push({ daemonId, u })
  }
  async agentRemove(daemonId: string, r: AgentRemove): Promise<void> {
    this.removes.push({ daemonId, r })
  }
  async collaborationRoutes(daemonId: string, snapshot: CollabRoutesSnapshot): Promise<void> {
    this.collaboration.push({ daemonId, snapshot })
  }
}

const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'

function withSpy(): { app: HttpApp; spy: SpyControl } {
  const spy = new SpyControl()
  const app = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
  running = app
  return { app, spy }
}

describe('agent config replication CP→daemon (REST → agent/upsert·remove)', () => {
  it('directional visibility hot-pushes the source spec and collaboration snapshot', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    const peerId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedAgent(prisma, peerId)
    const { app, spy } = withSpy()

    const update = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/call-policy`,
      payload: {
        callPolicy: 'all',
        allowedCallerAgentIds: [],
        outboundPolicy: 'selected',
        allowedTargetAgentIds: [peerId]
      }
    })

    expect(update.statusCode).toBe(200)
    expect(spy.upserts.at(-1)?.u.spec).toMatchObject({
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [peerId]
    })
    expect(spy.collaboration.at(-1)).toMatchObject({ daemonId: DAEMON, snapshot: { channels: [] } })
  })

  it('creating an already-PLACED agent publishes it into the flat peer directory', async () => {
    // Regression: discovery (`channel/agents`) reads the DB live, but a peer WAKE is
    // authorized against the pushed collaboration snapshot. If creation did not push one,
    // a brand-new agent would be listed-but-uncallable — and since the directory is no
    // longer channel-gated, no `integration/channels` report would ever fix it.
    await seedDaemon(prisma, DAEMON)
    const { app, spy } = withSpy()

    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'placed-at-birth', runtime: 'claude', daemonId: DAEMON, callPolicy: 'all' }
    })
    expect(created.statusCode).toBe(201)
    const { id } = created.json() as { id: string }

    const snapshot = spy.collaboration.at(-1)
    expect(snapshot?.daemonId).toBe(DAEMON)
    // Present in the flat org directory despite having NO integration/channel at all.
    expect(snapshot?.snapshot.channels).toEqual([])
    expect(snapshot?.snapshot.agents).toEqual([
      expect.objectContaining({ agentId: id, daemonId: DAEMON, orgId: DEFAULT_ORG_ID, callPolicy: 'all' })
    ])
  })

  it('creating an UNPLACED agent pushes no snapshot — nothing routable to publish yet', async () => {
    await seedDaemon(prisma, DAEMON)
    const { app, spy } = withSpy()

    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'unplaced', runtime: 'claude' }
    })
    expect(created.statusCode).toBe(201)
    // `buildCollabSnapshot` drops daemonId-less rows, so a broadcast here would publish
    // nothing while bumping every daemon's routingEpoch. Reconcile is the backstop.
    expect(spy.collaboration).toHaveLength(0)
  })

  it('PATCH on a PLACED agent pushes agent/upsert with the edited spec to its daemon', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const { app, spy } = withSpy()

    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: {
        description: 'You review PRs.',
        model: 'opus',
        reasoningEffort: 'high',
        outputMode: 'medium',
        fastMode: true,
        env: { GITHUB_TOKEN: 'ghp_x' },
        mcpServers: ['github', 'metrics']
      }
    })
    expect(patch.statusCode).toBe(200)

    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]!.daemonId).toBe(DAEMON)
    expect(spy.upserts[0]!.u).toEqual({
      agentId,
      spec: {
        agentId,
        name: `agent-${agentId.slice(0, 4)}`, // seeded slug (name is immutable)
        displayName: null,
        // Always shipped value-or-null (like displayName): null here — the agent has no
        // icon and no PUBLIC_CP_URL is configured in the test, so no avatar URL resolves.
        iconUrl: null,
        runtime: 'claude',
        description: 'You review PRs.',
        model: 'opus',
        reasoningEffort: 'high',
        // Always shipped as null when unset (per-runtime override): a runtime switch
        // must be able to CLEAR it, so the spec carries the clear rather than omitting it.
        permissionMode: null,
        outputMode: 'medium',
        showFooter: true,
        showStatusBar: true,
        allowRuntimeChangesInChat: false,
        fastMode: true,
        env: { GITHUB_TOKEN: 'ghp_x' },
        secrets: {}, // write-only secrets ride the same wire as env; always shipped (even {})
        mcpServers: ['github', 'metrics'],
        // Skills enable-list resolves to inline entries; none enabled here ⇒ always shipped [].
        skills: [],
        // Managed organization skills are a distinct explicit enable-list.
        managedSkills: [],
        // Agent→agent call policy (§2.5) — always shipped so a policy/allow-list change replicates.
        callPolicy: 'all',
        allowedCallerAgentIds: [],
        outboundPolicy: 'all',
        allowedTargetAgentIds: [],
        // #536: self-introduce-on-join — always shipped (definite column) so a toggle replicates.
        introduceOnJoin: false,
        // #642: sandbox preference — always shipped (definite column); default false.
        runInSandbox: false,
        // Preset marker — always shipped so the daemon can gate preset-only capabilities.
        builtin: false,
        workspace: { mode: 'scratch', gitCredential: 'github-app' }
      }
    })

    // Removing the last variable must still replicate: the daemon merge treats an
    // absent env as "leave alone", so the spec always ships env — {} included.
    // Same rule for mcpServers: disabling the last server must ship [].
    const clear = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { env: {}, mcpServers: null }
    })
    expect(clear.statusCode).toBe(200)
    expect(spy.upserts).toHaveLength(2)
    expect(spy.upserts[1]!.u.spec.env).toEqual({})
    expect(spy.upserts[1]!.u.spec.mcpServers).toEqual([])
  })

  it('PATCHed secrets replicate on the wire spec (values from the AgentSecretStore, never the DTO)', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const { app, spy } = withSpy()

    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { secrets: { API_KEY: 'sk-live' } }
    })
    expect(patch.statusCode).toBe(200)
    // The daemon replica gets the VALUE (it must inject the env at spawn)…
    expect(spy.upserts.at(-1)!.u.spec.secrets).toEqual({ API_KEY: 'sk-live' })
    // …while the HTTP response only ever carried the key name.
    expect(patch.body).not.toContain('sk-live')

    // Deleting the last secret must still replicate — the spec always ships secrets ({}).
    const clear = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { secrets: { API_KEY: null } }
    })
    expect(clear.statusCode).toBe(200)
    expect(spy.upserts.at(-1)!.u.spec.secrets).toEqual({})
  })

  it('PATCH replicates a changed and cleared GitHub working subdirectory', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {
      daemonId: DAEMON,
      gitRepo: 'https://github.com/acme/monorepo'
    })
    const { app, spy } = withSpy()

    const update = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { agentDir: './services/api' }
    })
    expect(update.statusCode).toBe(200)
    expect(spy.upserts.at(-1)?.u.spec.workspace).toMatchObject({
      mode: 'github',
      agentDir: 'services/api'
    })

    const clear = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { agentDir: null }
    })
    expect(clear.statusCode).toBe(200)
    expect(spy.upserts.at(-1)?.u.spec.workspace).toEqual({
      mode: 'github',
      gitRepo: 'https://github.com/acme/monorepo',
      branch: 'main'
    })
  })

  it('DELETE on a PLACED agent removes it from C6 and pushes agent/remove to its daemon', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const { app, spy } = withSpy()

    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` })
    expect(del.statusCode).toBe(204)
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toBeNull()

    expect(spy.removes).toHaveLength(1)
    expect(spy.removes[0]!).toEqual({ daemonId: DAEMON, r: { agentId } })
  })

  it('DELETE on a PLACED agent also WITHDRAWS it from the flat peer directory', async () => {
    // The mirror of the create push. `agent/remove` only clears the daemon's local spec
    // replica (same-daemon authorization); a peer WAKE is authorized against the pushed
    // collaboration snapshot, so without a broadcast every OTHER daemon in the org keeps a
    // flat `agents[]` entry whose `admits()` still says yes — a wake routed at a row that
    // no longer exists.
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const { app, spy } = withSpy()

    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` })
    expect(del.statusCode).toBe(204)

    const snapshot = spy.collaboration.at(-1)
    expect(snapshot?.daemonId).toBe(DAEMON)
    expect(snapshot?.snapshot.agents.map((a) => a.agentId)).not.toContain(agentId)
  })

  it('an UNPLACED agent (no daemonId) pushes nothing — reconcile is the backstop', async () => {
    const { app, spy } = withSpy()

    // POST always creates unplaced (placement happens over the WS edge).
    const created = (
      await app.app.inject({ method: 'POST', url: `${ORG}/agents`, payload: { name: 'p', runtime: 'claude' } })
    ).json() as { id: string }
    // PATCH + DELETE while still unplaced.
    await app.app.inject({ method: 'PATCH', url: `${ORG}/agents/${created.id}`, payload: { description: 'x' } })
    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${created.id}` })
    expect(del.statusCode).toBe(204)

    expect(spy.upserts).toHaveLength(0)
    expect(spy.removes).toHaveLength(0)
    // Nor a collaboration snapshot: an unplaced agent was never in one, so there is nothing
    // to publish or withdraw and no reason to churn every daemon's routingEpoch.
    expect(spy.collaboration).toHaveLength(0)
  })

  it('a NoConnection from an offline daemon is swallowed — the request still succeeds', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })

    // A real ControlSender over an EMPTY connection registry throws NoConnection
    // for this placed-but-disconnected daemon (must() fails before seq/launch are
    // touched, so those collaborators can be trivial stubs); the route must not
    // surface it.
    const offline = new ControlSender(
      { get: () => undefined } as unknown as ConstructorParameters<typeof ControlSender>[0],
      { currentLaunch: async () => undefined } as unknown as ConstructorParameters<typeof ControlSender>[1]
    )
    // Sanity: it really does throw NoConnection for an unknown daemon.
    await expect(
      offline.agentUpsert(DAEMON, {
        agentId,
        spec: {
          name: 'x',
          mcpServers: [],
          skills: [],
          managedSkills: [],
          allowedCallerAgentIds: [],
          allowedTargetAgentIds: []
        }
      })
    ).rejects.toBeInstanceOf(NoConnection)

    running = buildHttpApp(prisma, undefined, undefined, offline)
    const patch = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { description: 'renamed' }
    })
    expect(patch.statusCode).toBe(200)
    expect((patch.json() as { description: string }).description).toBe('renamed')

    const del = await running.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` })
    expect(del.statusCode).toBe(204)
  })

  it('a failed live reconcile (non-NoConnection) is also swallowed — the persisted PATCH still succeeds', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })

    // The daemon is CONNECTED but its live reconcile REJECTS the upsert — `agent/upsert` became
    // a blocking request-ack in #740, and a rejected ack throws a generic Error (not
    // NoConnection). The update is already persisted, so the request must still succeed (the
    // daemon re-syncs from the register/ok roster on reconnect) — a reconcile hiccup must not
    // 500 the write. Regression for the #740 PATCH-500.
    const failing = {
      agentUpsert: async () => {
        throw new Error('agent upsert rejected: agent/upsert failed')
      },
      agentRemove: async () => {}
    } as unknown as ControlSender
    running = buildHttpApp(prisma, undefined, undefined, failing)

    const patch = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { memory: { provider: 'none' }, description: 'persisted despite reconcile failure' }
    })
    expect(patch.statusCode).toBe(200)
    expect((patch.json() as { description: string }).description).toBe('persisted despite reconcile failure')
  })
})

// A registry MCP provider's proxy def (relay URL + grant key) reaches a daemon ONLY
// via provider CRUD or an agent enabling/disabling it — so the agent enable-list
// transition MUST push/remove the def, or a provider enabled after creation never
// installs on the daemon and the next session can't resolve it.
class McpSpyControl {
  readonly mcpUpserts: Array<{ daemonId: string; spec: { name: string; url: string; headers: unknown[] } }> = []
  readonly mcpRemoves: Array<{ daemonId: string; name: string }> = []
  async agentUpsert(): Promise<void> {}
  async agentRemove(): Promise<void> {}
  async mcpServerUpsert(daemonId: string, spec: { name: string; url: string; headers: unknown[] }): Promise<void> {
    this.mcpUpserts.push({ daemonId, spec })
  }
  async mcpServerRemove(daemonId: string, name: string): Promise<void> {
    this.mcpRemoves.push({ daemonId, name })
  }
}

async function seedProviderAndRelay(): Promise<{ providerId: string; grantKey: string }> {
  const provider = await prisma.mcpProvider.create({
    data: { orgId: DEFAULT_ORG_ID, name: 'fakemcp', url: 'http://upstream.example/mcp' }
  })
  await prisma.mcpGrant.create({ data: { mcpProviderId: provider.id, key: 'oct_testkey' } })
  await prisma.relay.create({
    data: { id: randomUUID(), name: 'relay-1', daemonUrl: 'ws://relay.example:8443', lastSeenAt: new Date() }
  })
  return { providerId: provider.id, grantKey: 'oct_testkey' }
}

describe('agent MCP enable-list → daemon proxy-def push (REST → mcpserver/upsert·remove)', () => {
  it('enabling a registry provider on a placed agent pushes its proxy def to the daemon', async () => {
    await seedDaemon(prisma, DAEMON)
    const { providerId } = await seedProviderAndRelay()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON }) // no MCP servers enabled yet

    const spy = new McpSpyControl()
    running = buildHttpApp(prisma, { RELAY_STALE_MS: 60_000 }, undefined, spy as unknown as ControlSender)
    const res = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: ['fakemcp'] }
    })
    expect(res.statusCode).toBe(200)
    expect(spy.mcpUpserts).toHaveLength(1)
    expect(spy.mcpUpserts[0]!.daemonId).toBe(DAEMON)
    // The pushed def is the RELAY proxy URL + the grant-key bearer — never the upstream.
    expect(spy.mcpUpserts[0]!.spec.url).toBe(`http://relay.example:8443/mcp/${providerId}`)
    expect(spy.mcpUpserts[0]!.spec.headers).toEqual([{ name: 'Authorization', value: 'Bearer oct_testkey' }])
    expect(spy.mcpRemoves).toHaveLength(0)
  })

  it('disabling the last agent using a provider removes its proxy def from the daemon', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedProviderAndRelay()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })

    const spy = new McpSpyControl()
    running = buildHttpApp(prisma, { RELAY_STALE_MS: 60_000 }, undefined, spy as unknown as ControlSender)
    // Enable through the API first (the enable-list is stored in runtimeOverrides JSON),
    // then disable — the disable must emit exactly the remove.
    const enable = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: ['fakemcp'] }
    })
    expect(enable.statusCode).toBe(200)
    expect(spy.mcpUpserts).toHaveLength(1)

    const disable = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: [] }
    })
    expect(disable.statusCode).toBe(200)
    expect(spy.mcpRemoves).toEqual([{ daemonId: DAEMON, name: 'fakemcp' }])
    expect(spy.mcpUpserts).toHaveLength(1) // no further upsert on disable
  })
})
