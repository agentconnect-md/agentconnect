import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import type { SecretCipher } from '../../src/secrets/cipher.js'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DeploymentConfigConflictError,
  DeploymentConfigMissingSecretsError,
  DeploymentConfigSecretRefreshRequiredError,
  type DeploymentConfigValuesV1
} from '../../src/persistence/deployment-config.js'
import { PgDeploymentConfigStore } from '../../src/persistence/repositories/deployment-config.repo.js'

class PrefixCipher implements SecretCipher {
  seal(plaintext: string): Promise<string> {
    return Promise.resolve(`sealed:${plaintext}`)
  }

  open(stored: string): Promise<string> {
    return Promise.resolve(stored.startsWith('sealed:') ? stored.slice('sealed:'.length) : stored)
  }
}

const GITHUB_VALUES: DeploymentConfigValuesV1 = {
  ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  publicUrls: {
    ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1.publicUrls,
    controlPlane: 'https://api.example.test',
    web: 'https://console.example.test',
    relay: 'https://relay.example.test'
  },
  github: { appId: 123, slug: 'agentconnect-test', clientId: 'Iv1.test' }
}

describe('deployment configuration store (real Postgres)', () => {
  it('atomically replaces typed settings and a write-only sealed secret patch', async () => {
    const store = new PgDeploymentConfigStore(prisma, new PrefixCipher())
    expect(await store.getAdmin()).toBeNull()

    // Enabling a group without its required effective secret set must not leave
    // even the newly-created singleton row behind.
    await expect(store.replace({ expectedRevision: 0, values: GITHUB_VALUES })).rejects.toEqual(
      new DeploymentConfigMissingSecretsError(['github.privateKeyB64', 'github.webhookSecret'])
    )
    expect(await prisma.deploymentConfig.count()).toBe(0)

    const created = await store.replace({
      expectedRevision: 0,
      values: GITHUB_VALUES,
      secrets: {
        'github.privateKeyB64': 'private-material',
        'github.webhookSecret': 'webhook-material',
        'github.clientSecret': 'oauth-material'
      }
    })
    expect(created.revision).toBe(1)
    expect(created.secrets.find(({ key }) => key === 'github.privateKeyB64')).toMatchObject({
      configured: true,
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/)
    })
    expect(JSON.stringify(created)).not.toContain('private-material')

    const stored = await prisma.deploymentSecret.findUniqueOrThrow({
      where: { deploymentConfigId_key: { deploymentConfigId: 1, key: 'github.privateKeyB64' } }
    })
    expect(stored.value).toBe('sealed:private-material')

    expect(await store.getRuntime()).toMatchObject({
      revision: 1,
      secrets: {
        'github.privateKeyB64': 'private-material',
        'github.webhookSecret': 'webhook-material'
      }
    })
    expect((await store.getRuntime(['github.webhookSecret']))?.secrets).toEqual({
      'github.webhookSecret': 'webhook-material'
    })

    await expect(store.replace({ expectedRevision: 0, values: { ...GITHUB_VALUES, github: null } })).rejects.toEqual(
      new DeploymentConfigConflictError(0, 1)
    )

    // Omitted secret keys survive a full non-secret replacement.
    const updated = await store.replace({
      expectedRevision: 1,
      values: {
        ...GITHUB_VALUES,
        features: { ...GITHUB_VALUES.features, presetAgentsEnabled: false }
      }
    })
    expect(updated.revision).toBe(2)
    expect((await store.getRuntime())?.secrets['github.webhookSecret']).toBe('webhook-material')

    // Clearing a still-required key fails inside the same transaction: neither
    // the revision nor the secret row changes.
    await expect(
      store.replace({ expectedRevision: 2, values: GITHUB_VALUES, secrets: { 'github.webhookSecret': null } })
    ).rejects.toBeInstanceOf(DeploymentConfigMissingSecretsError)
    expect((await store.getAdmin())?.revision).toBe(2)
    expect((await store.getRuntime())?.secrets['github.webhookSecret']).toBe('webhook-material')

    // Disabling a provider retains its encrypted material for later re-enable,
    // but the runtime no longer opens or projects those dormant secrets.
    const disabled = await store.replace({
      expectedRevision: 2,
      values: { ...GITHUB_VALUES, github: null }
    })
    expect(disabled.revision).toBe(3)
    expect((await store.getRuntime())?.secrets).toEqual({})
    expect(await prisma.deploymentSecret.count({ where: { deploymentConfigId: 1 } })).toBe(3)

    await expect(store.replace({ expectedRevision: 3, values: GITHUB_VALUES })).rejects.toBeInstanceOf(
      DeploymentConfigSecretRefreshRequiredError
    )
    expect((await store.getAdmin())?.revision).toBe(3)

    await store.markAdminClaimed(3, 'oidc-claim-key')
    expect((await store.getAdmin())?.adminClaimedFor).toBe('oidc-claim-key')
    await expect(store.markAdminClaimed(2, 'stale')).rejects.toEqual(new DeploymentConfigConflictError(2, 3))
  })
})
