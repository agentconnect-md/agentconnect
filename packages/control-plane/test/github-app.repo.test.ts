import { describe, expect, it } from 'vitest'
import { OrgId } from '../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../src/config/defaults.js'
import { PgGithubAppRepo, PgGithubAppSecretStore, PgGithubInstallationRepo } from '../src/persistence/index.js'
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

describe('PgGithubAppRepo + PgGithubInstallationRepo (dedicated Apps)', () => {
  it('resolves an account per App: the deployment and a registered App never stand in for each other', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const installations = new PgGithubInstallationRepo(prisma)
    const app = await apps.create({ orgId: ORG, appId: 2000n, slug: 'example-review', clientId: null, botUserId: 77n })

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

  it('deleting an App cascades to its installations and detaches its agents', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const installations = new PgGithubInstallationRepo(prisma)
    const app = await apps.create({ orgId: ORG, appId: 2001n, slug: 'example-coder', clientId: 'Iv1', botUserId: null })
    await installations.upsertFromGithub(ORG, facts(44n), app.id)
    const agent = await prisma.agent.create({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        orgId: ORG,
        name: 'coder',
        runtime: 'claude',
        githubAppId: app.id
      }
    })
    expect(agent.githubAppId).toBe(app.id)

    await expect(apps.get(OrgId('other-org'), app.id)).resolves.toBeNull()
    await expect(apps.delete(ORG, app.id)).resolves.toBe(true)
    await expect(installations.getByInstallationId(44n)).resolves.toBeNull()
    await expect(prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).resolves.toMatchObject({
      githubAppId: null
    })
  })

  it('seals the private key under the org and refuses a cross-org write', async () => {
    const apps = new PgGithubAppRepo(prisma)
    const secrets = new PgGithubAppSecretStore(prisma, new PlaintextSecretCipher())
    const app = await apps.create({ orgId: ORG, appId: 2002n, slug: 'example-keys', clientId: null, botUserId: null })
    await secrets.put(ORG, app.id, 'cGVt')
    await expect(secrets.get(ORG, app.id)).resolves.toBe('cGVt')
    await expect(secrets.get(OrgId('other-org'), app.id)).resolves.toBeNull()
    await expect(secrets.put(OrgId('other-org'), app.id, 'x')).rejects.toThrow(/outside its organization/)
  })
})
