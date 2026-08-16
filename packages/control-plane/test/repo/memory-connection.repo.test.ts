import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEF_ORG } from '../fixtures/seed.js'
import {
  PgExternalMemoryConnectionRepo,
  PgExternalMemoryConnectionSecretStore,
  PgExternalMemoryGrantRepo,
  PgMemoryPluginInstallationRepo
} from '../../src/persistence/repositories/memory-connection.repo.js'
import type { SecretCipher } from '../../src/secrets/cipher.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const DAEMON_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'

class PrefixCipher implements SecretCipher {
  seal(plaintext: string): Promise<string> {
    return Promise.resolve(`sealed:${plaintext}`)
  }
  open(stored: string): Promise<string> {
    return Promise.resolve(stored.startsWith('sealed:') ? stored.slice('sealed:'.length) : stored)
  }
}

async function fixture() {
  const installations = new PgMemoryPluginInstallationRepo(prisma)
  const connections = new PgExternalMemoryConnectionRepo(prisma)
  const installation = await installations.create({
    orgId: OrgId(DEFAULT_ORG_ID),
    pluginId: 'ai.example.memory',
    transport: 'streamable-http',
    endpoint: 'https://plugin.example/mcp',
    pinnedProfileMajor: 1,
    secretHeaders: [{ name: 'apiKey', header: 'X-Api-Key', required: true }],
    createdByUserId: DEFAULT_OWNER_ID
  })
  const connection = await connections.create({
    orgId: OrgId(DEFAULT_ORG_ID),
    installationId: installation.id,
    config: { projectId: 'p1' },
    createdByUserId: DEFAULT_OWNER_ID
  })
  return { installations, connections, installation, connection }
}

describe('external-memory persistence (real Postgres)', () => {
  it('round-trips installation/connection metadata and revision-fences probe facts', async () => {
    const { connections, connection } = await fixture()
    expect(connection).toMatchObject({ status: 'probing', revision: 1, config: { projectId: 'p1' } })

    expect(
      await connections.updateProbeFact(connection.id, 1, {
        status: 'ready',
        pluginVersion: '1.2.3',
        profile: 'agentconnect.memory/v1',
        manifestDigest: `sha256:${'a'.repeat(64)}`,
        capabilities: { scopes: ['agent'] },
        declaredEgressHosts: ['api.example-memory.com']
      })
    ).toBe(true)
    expect(await connections.get(DEF_ORG, connection.id)).toMatchObject({
      status: 'ready',
      probedRevision: 1,
      declaredEgressHosts: ['api.example-memory.com']
    })

    const updated = await connections.update(DEF_ORG, connection.id, { config: { projectId: 'p2' } })
    expect(updated).toMatchObject({ revision: 2, status: 'probing', probedRevision: null })
    expect(await connections.updateProbeFact(connection.id, 1, { status: 'invalid' })).toBe(false)
    expect((await connections.get(DEF_ORG, connection.id))?.status).toBe('probing')
    expect(await connections.updateProbeFact(connection.id, 2, { status: 'degraded', reasonCode: 'timeout' })).toBe(
      true
    )
    expect(await connections.get(DEF_ORG, connection.id)).toMatchObject({
      revision: 2,
      probedRevision: 2,
      status: 'degraded',
      reasonCode: 'timeout'
    })
  })

  it('seals every secret/grant at rest, exposes only opened values through the dedicated stores, and cascades', async () => {
    const { connections, connection } = await fixture()
    const cipher = new PrefixCipher()
    const secrets = new PgExternalMemoryConnectionSecretStore(prisma, cipher)
    const grants = new PgExternalMemoryGrantRepo(prisma, cipher)
    await secrets.put(OrgId(DEFAULT_ORG_ID), connection.id, { apiKey: 'upstream-secret', tenant: 'acme' })
    const minted = await grants.mintFor(OrgId(DEFAULT_ORG_ID), connection.id)

    const secretRow = await prisma.externalMemoryConnectionSecret.findUniqueOrThrow({
      where: { connectionId: connection.id }
    })
    expect(secretRow.values).toEqual({ apiKey: 'sealed:upstream-secret', tenant: 'sealed:acme' })
    expect(await secrets.get(OrgId(DEFAULT_ORG_ID), connection.id)).toEqual({
      apiKey: 'upstream-secret',
      tenant: 'acme'
    })
    expect(await secrets.keys(OrgId(DEFAULT_ORG_ID), connection.id)).toEqual(['apiKey', 'tenant'])
    const grantRow = await prisma.externalMemoryGrant.findUniqueOrThrow({ where: { id: minted.id } })
    expect(grantRow.key).toBe(`sealed:${minted.key}`)
    expect((await grants.activeForConnection(OrgId(DEFAULT_ORG_ID), connection.id))[0]?.key).toBe(minted.key)

    await grants.revoke(minted.id)
    expect(await grants.activeForConnection(OrgId(DEFAULT_ORG_ID), connection.id)).toEqual([])
    await connections.delete(DEF_ORG, connection.id)
    expect(await prisma.externalMemoryConnectionSecret.count()).toBe(0)
    expect(await prisma.externalMemoryGrant.count()).toBe(0)
  })
})
