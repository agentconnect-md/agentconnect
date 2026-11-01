import { describe, expect, it } from 'vitest'
import { AgentId, OrgId } from '../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../src/config/defaults.js'
import {
  PgAgentRepo,
  PgGithubAppRepo,
  PgGithubAppSecretStore,
  PgGithubInstallationRepo
} from '../src/persistence/index.js'
import { PlaintextSecretCipher } from '../src/secrets/cipher.js'
import { prisma } from './setup.db.js'

const ORG = OrgId(DEFAULT_ORG_ID)
const facts = (installationId: bigint, accountLogin = 'Acme') => ({
  installationId,
  accountLogin,
  accountType: 'Organization',
  repositorySelection: 'all' as const,
  suspendedAt: null,
  permissions: {}
})

let seq = 0
async function agent(name: string, data: { installationId?: string } = {}): Promise<string> {
  seq += 1
  const id = `11111111-1111-4111-8111-${String(seq).padStart(12, '0')}`
  await prisma.agent.create({ data: { id, orgId: ORG, name, runtime: 'claude', ...data } })
  return id
}

function orgApp(appId: bigint, slug: string) {
  return { id: crypto.randomUUID(), orgId: ORG, appId, slug, clientId: null, botUserId: 77n }
}

describe('PgGithubAppRepo + PgGithubInstallationRepo (organization Apps)', () => {
  it('resolves an account per App: the built-in and an organization App never stand in for each other', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const installations = new PgGithubInstallationRepo(prisma)
    const app = await apps.create(orgApp(2000n, 'example-review'))
    expect(app.agentId).toBeNull()

    await installations.upsertFromGithub(ORG, facts(42n))
    await installations.upsertFromGithub(ORG, facts(43n), app.id)

    await expect(installations.liveByOrgAndAccount(ORG, 'acme')).resolves.toMatchObject({ installationId: 42n })
    await expect(installations.liveByOrgAndAccount(ORG, 'acme', app.id)).resolves.toMatchObject({
      installationId: 43n,
      githubAppId: app.id
    })
    expect((await installations.listForOrg(ORG)).map((i) => i.installationId)).toEqual([42n])
    await installations.upsertFromGithub(ORG, facts(43n))
    await expect(installations.getByInstallationId(43n)).resolves.toMatchObject({ githubAppId: app.id })
  })

  it("switches an agent and moves every installation it records to the App's on the same account", async () => {
    const apps = new PgGithubAppRepo(prisma)
    const installations = new PgGithubInstallationRepo(prisma)
    const app = await apps.create(orgApp(2001n, 'example-coder'))
    const builtIn = await installations.upsertFromGithub(ORG, facts(52n))
    const own = await installations.upsertFromGithub(ORG, facts(53n), app.id)
    const agentId = await agent('coder', { installationId: builtIn.id })
    await prisma.agentInstallationAuthorization.create({
      data: { agentId, installationId: 52n, accountLogin: 'Acme', access: 'write' }
    })
    await prisma.hookDef.create({
      data: {
        orgId: ORG,
        agentId,
        kind: 'github',
        name: 'reviews',
        sessionMode: 'perThread',
        installationId: 52n,
        installationAccount: 'Acme'
      }
    })
    const moved = async () => ({
      agent: await prisma.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { githubAppId: true, installationId: true }
      }),
      grant: (await prisma.agentInstallationAuthorization.findFirstOrThrow({ where: { agentId } })).installationId,
      hook: (await prisma.hookDef.findFirstOrThrow({ where: { agentId } })).installationId
    })

    await expect(apps.switchAgent({ orgId: ORG, agentId, from: null, to: app.id })).resolves.toEqual({ ok: true })
    await expect(moved()).resolves.toEqual({
      agent: { githubAppId: app.id, installationId: own.id },
      grant: 53n,
      hook: 53n
    })
    await expect(apps.get(ORG, app.id)).resolves.toMatchObject({ agentId })

    // A second agent cannot take it, and a stale `from` is refused.
    const other = await agent('other')
    await expect(apps.switchAgent({ orgId: ORG, agentId: other, from: null, to: app.id })).resolves.toEqual({
      ok: false,
      kind: 'app_in_use'
    })
    await expect(apps.switchAgent({ orgId: ORG, agentId, from: null, to: null })).resolves.toEqual({
      ok: false,
      kind: 'agent_changed'
    })

    // Back to the built-in App: everything returns to its installation.
    await expect(apps.switchAgent({ orgId: ORG, agentId, from: app.id, to: null })).resolves.toEqual({ ok: true })
    await expect(moved()).resolves.toEqual({
      agent: { githubAppId: null, installationId: builtIn.id },
      grant: 52n,
      hook: 52n
    })
  })

  it('leaves nothing changed when the target App has no installation on an account the agent uses', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const installations = new PgGithubInstallationRepo(prisma)
    const app = await apps.create(orgApp(2002n, 'example-partial'))
    await installations.upsertFromGithub(ORG, facts(62n, 'Beta'))
    const agentId = await agent('partial')
    await prisma.agentInstallationAuthorization.create({
      data: { agentId, installationId: 62n, accountLogin: 'Beta', access: 'read' }
    })
    await expect(apps.switchAgent({ orgId: ORG, agentId, from: null, to: app.id })).resolves.toEqual({
      ok: false,
      kind: 'missing_installation',
      accountLogin: 'Beta'
    })
    await expect(prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).resolves.toMatchObject({
      githubAppId: null
    })
  })

  it('deletes only a free App with no Check left to close; deleting its agent frees it', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const installations = new PgGithubInstallationRepo(prisma)
    const app = await apps.create(orgApp(2003n, 'example-busy'))
    await installations.upsertFromGithub(ORG, facts(72n, 'Gamma'), app.id)
    const agentId = await agent('busy')
    await apps.switchAgent({ orgId: ORG, agentId, from: null, to: app.id })
    await expect(apps.deleteFree(ORG, app.id)).resolves.toBe(false)

    await new PgAgentRepo(prisma).delete(ORG, AgentId(agentId))
    await expect(apps.get(ORG, app.id)).resolves.toMatchObject({ agentId: null })

    const projection = await prisma.hookReviewProjection.create({
      data: {
        hookId: '33333333-3333-4333-8333-333333333333',
        orgId: ORG,
        agentId,
        lastResolvedInstallationId: 72n,
        repoId: 9n,
        repoFullName: 'gamma/tools',
        headSha: 'a'.repeat(40),
        reportSha: 'a'.repeat(40),
        projectionEpoch: 1n,
        externalId: '55555555-5555-4555-8555-555555555555',
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'failure',
        tombstonedAt: new Date(),
        nextAttemptAt: null
      }
    })
    // A cleanup still to run (observed state unknown) keeps it; one settled at failure frees it.
    await expect(apps.deleteFree(ORG, app.id)).resolves.toBe(false)
    await prisma.hookReviewProjection.update({ where: { id: projection.id }, data: { observedState: 'failure' } })
    await expect(apps.deleteFree(OrgId('other-org'), app.id)).resolves.toBe(false)
    await expect(apps.deleteFree(ORG, app.id)).resolves.toBe(true)
    await expect(installations.getByInstallationId(72n)).resolves.toBeNull()
  })

  it('seals the private key and webhook secret under the org and refuses a cross-org write', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const secrets = new PgGithubAppSecretStore(prisma, new PlaintextSecretCipher())
    const app = await apps.create(orgApp(2004n, 'example-keys'))
    await secrets.put(ORG, app.id, 'cGVt', 'whsec')
    await expect(secrets.get(ORG, app.id)).resolves.toBe('cGVt')
    await expect(secrets.get(OrgId('other-org'), app.id)).resolves.toBeNull()
    await expect(secrets.listWebhooks()).resolves.toEqual([
      { githubAppId: app.id, appId: 2004n, webhookSecret: 'whsec' }
    ])
    await expect(secrets.put(OrgId('other-org'), app.id, 'x')).rejects.toThrow(/outside its organization/)
  })
})
