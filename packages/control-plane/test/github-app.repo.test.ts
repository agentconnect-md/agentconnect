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

  it('deleting the App detaches its agent; deleting the agent deletes its App and installations', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const installations = new PgGithubInstallationRepo(prisma)
    const kept = await agent('kept')
    const keptApp = (await apps.createForAgent(appFor(kept, 2004n, 'example-kept')))!
    await installations.upsertFromGithub(ORG, facts(44n), keptApp.id)
    await expect(apps.get(OrgId('other-org'), keptApp.id)).resolves.toBeNull()
    await expect(apps.delete(ORG, keptApp.id)).resolves.toBe(true)
    await expect(installations.getByInstallationId(44n)).resolves.toBeNull()
    await expect(prisma.agent.findUniqueOrThrow({ where: { id: kept } })).resolves.toMatchObject({ githubAppId: null })

    const gone = await agent('gone')
    const goneApp = (await apps.createForAgent(appFor(gone, 2005n, 'example-gone')))!
    await installations.upsertFromGithub(ORG, facts(45n), goneApp.id)
    await new PgAgentRepo(prisma).delete(ORG, AgentId(gone))
    await expect(apps.getUnscoped(goneApp.id)).resolves.toBeNull()
    await expect(installations.getByInstallationId(45n)).resolves.toBeNull()
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
