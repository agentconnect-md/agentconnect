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
const facts = (installationId: bigint) => ({
  installationId,
  accountLogin: 'Acme',
  accountType: 'Organization',
  repositorySelection: 'all' as const,
  suspendedAt: null,
  permissions: {}
})

let seq = 0
async function agent(name: string): Promise<string> {
  seq += 1
  const id = `11111111-1111-4111-8111-${String(seq).padStart(12, '0')}`
  await prisma.agent.create({ data: { id, orgId: ORG, name, runtime: 'claude' } })
  return id
}

function appFor(agentId: string, appId: bigint, slug: string) {
  return {
    id: crypto.randomUUID(),
    orgId: ORG,
    agentId,
    appId,
    slug,
    clientId: null,
    botUserId: 77n
  }
}

describe('PgGithubAppRepo + PgGithubInstallationRepo (dedicated Apps)', () => {
  it('resolves an account per App: the deployment and a dedicated App never stand in for each other', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const installations = new PgGithubInstallationRepo(prisma)
    const app = (await apps.createForAgent(appFor(await agent('reviewer'), 2000n, 'example-review')))!

    await installations.upsertFromGithub(ORG, facts(42n))
    await installations.upsertFromGithub(ORG, facts(43n), app.id)

    await expect(installations.liveByOrgAndAccount(ORG, 'acme')).resolves.toMatchObject({ installationId: 42n })
    await expect(installations.liveByOrgAndAccount(ORG, 'acme', app.id)).resolves.toMatchObject({
      installationId: 43n,
      githubAppId: app.id
    })
    await expect(
      installations.liveByOrgAndAccount(ORG, 'acme', '00000000-0000-4000-8000-000000000000')
    ).resolves.toBeNull()
    // The picker's list is the deployment App's; the App's own roster lists beside it.
    expect((await installations.listForOrg(ORG)).map((i) => i.installationId)).toEqual([42n])
    expect((await installations.listClaimsForOrg(ORG)).map((i) => i.installationId).sort()).toEqual([42n, 43n])
    // A refresh without an App keeps the row's App.
    await installations.upsertFromGithub(ORG, facts(43n))
    await expect(installations.getByInstallationId(43n)).resolves.toMatchObject({ githubAppId: app.id })
  })

  it('binds one App to one agent: a second App for the same agent or a missing agent leaves no row', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const agentId = await agent('coder')
    const first = await apps.createForAgent(appFor(agentId, 2001n, 'example-coder'))
    expect(first).toMatchObject({ agentId, slug: 'example-coder' })
    await expect(apps.getForAgent(ORG, agentId)).resolves.toMatchObject({ id: first!.id })
    await expect(prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).resolves.toMatchObject({
      githubAppId: first!.id
    })

    await expect(apps.createForAgent(appFor(agentId, 2002n, 'example-coder-2'))).resolves.toBeNull()
    await expect(
      apps.createForAgent(appFor('22222222-2222-4222-8222-222222222222', 2003n, 'example-nobody'))
    ).resolves.toBeNull()
    expect((await apps.listForOrg(ORG)).map((a) => a.slug)).toEqual(['example-coder'])
  })

  it('retires the App when its agent drops it or is deleted, keeping its key and installations', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const installations = new PgGithubInstallationRepo(prisma)
    const kept = await agent('kept')
    const keptApp = (await apps.createForAgent(appFor(kept, 2004n, 'example-kept')))!
    await installations.upsertFromGithub(ORG, facts(44n), keptApp.id)
    await expect(apps.retire(OrgId('other-org'), keptApp.id, new Date())).resolves.toBe(false)
    await expect(apps.retire(ORG, keptApp.id, new Date())).resolves.toBe(true)
    await expect(prisma.agent.findUniqueOrThrow({ where: { id: kept } })).resolves.toMatchObject({ githubAppId: null })
    await expect(apps.get(ORG, keptApp.id)).resolves.toMatchObject({ agentId: null, retiredAt: expect.any(Date) })
    await expect(installations.getByInstallationId(44n)).resolves.toMatchObject({ githubAppId: keptApp.id })

    const gone = await agent('gone')
    const goneApp = (await apps.createForAgent(appFor(gone, 2005n, 'example-gone')))!
    await installations.upsertFromGithub(ORG, facts(45n), goneApp.id)
    await new PgAgentRepo(prisma).delete(ORG, AgentId(gone))
    await expect(apps.getUnscoped(goneApp.id)).resolves.toMatchObject({ agentId: null, retiredAt: expect.any(Date) })
    await expect(installations.getByInstallationId(45n)).resolves.toMatchObject({ githubAppId: goneApp.id })
  })

  it('reaps a retired App after its grace only once every Check on its installations is finished for good', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const installations = new PgGithubInstallationRepo(prisma)
    const retiredAt = new Date('2026-11-01T00:00:00Z')
    const app = (await apps.createForAgent(appFor(await agent('reaped'), 2007n, 'example-reaped')))!
    await installations.upsertFromGithub(ORG, facts(46n), app.id)
    await apps.retire(ORG, app.id, retiredAt)
    const projection = await prisma.hookReviewProjection.create({
      data: {
        hookId: '33333333-3333-4333-8333-333333333333',
        orgId: ORG,
        agentId: '44444444-4444-4444-8444-444444444444',
        lastResolvedInstallationId: 46n,
        repoId: 9n,
        repoFullName: 'acme/tools',
        headSha: 'a'.repeat(40),
        reportSha: 'a'.repeat(40),
        projectionEpoch: 1n,
        externalId: '55555555-5555-4555-8555-555555555555',
        mode: 'check',
        gateMode: 'informational',
        // A live review between two updates: nothing queued, yet its Check will be written again.
        desiredState: 'in_progress',
        observedState: 'in_progress'
      }
    })

    // Inside the grace, and past it while that Check can still be updated: kept.
    await expect(apps.reapRetired(retiredAt, 10)).resolves.toEqual([])
    const later = new Date(retiredAt.getTime() + 2 * 60 * 60 * 1000)
    await expect(apps.reapRetired(later, 10)).resolves.toEqual([])

    // A tombstone with cleanup still owed, then one settled at neutral (a later revocation can upgrade it): kept.
    const update = (data: Parameters<typeof prisma.hookReviewProjection.update>[0]['data']) =>
      prisma.hookReviewProjection.update({ where: { id: projection.id }, data })
    await update({ tombstonedAt: retiredAt, desiredState: 'failure', nextAttemptAt: retiredAt })
    await expect(apps.reapRetired(later, 10)).resolves.toEqual([])
    await update({ desiredState: 'neutral', observedState: 'neutral', nextAttemptAt: null })
    await expect(apps.reapRetired(later, 10)).resolves.toEqual([])
    // Cleanup blocked before it wrote anything: no retry scheduled and no observed state, still unfinished.
    await update({ desiredState: 'failure', observedState: null, lastErrorCode: 'repo_authorization' })
    await expect(apps.reapRetired(later, 10)).resolves.toEqual([])

    await update({ desiredState: 'failure', observedState: 'failure' })
    await expect(apps.reapRetired(later, 10)).resolves.toEqual([{ id: app.id, orgId: ORG, installationIds: [46n] }])
    await expect(apps.getUnscoped(app.id)).resolves.toBeNull()
    await expect(installations.getByInstallationId(46n)).resolves.toBeNull()
  })

  it('seals the private key under the org and refuses a cross-org write', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const secrets = new PgGithubAppSecretStore(prisma, new PlaintextSecretCipher())
    const app = (await apps.createForAgent(appFor(await agent('keys'), 2006n, 'example-keys')))!
    await secrets.put(ORG, app.id, 'cGVt')
    await expect(secrets.get(ORG, app.id)).resolves.toBe('cGVt')
    await expect(secrets.get(OrgId('other-org'), app.id)).resolves.toBeNull()
    await expect(secrets.put(OrgId('other-org'), app.id, 'x')).rejects.toThrow(/outside its organization/)
  })
})
