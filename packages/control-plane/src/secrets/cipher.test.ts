/**
 * `SecretCipher` — the at-rest seam every persisted secret value passes through.
 * The identity cipher must be EXACTLY identity: existing plaintext rows keep
 * reading back unchanged, so wiring it in is a pure no-op deploy.
 */
import { describe, it, expect } from 'vitest'
import { PlaintextSecretCipher, type SecretCipher } from './cipher.js'
import { DEPLOYMENT_SCOPE, effectiveOrgKeyPrefix, orgKeyPrefixConflict, orgScope } from './scope.js'
import { OrgId } from '../domain/ids.js'

describe('PlaintextSecretCipher', () => {
  it('seal and open are both identity, whatever the scope (plaintext at rest)', async () => {
    const cipher: SecretCipher = new PlaintextSecretCipher()
    for (const scope of [DEPLOYMENT_SCOPE, orgScope(OrgId('org-1'))]) {
      for (const value of ['xoxb-token', '', 'vault:v1:already-looks-sealed', 'acv1:looks-enveloped', 'multibyte ✓']) {
        expect(await cipher.seal(value, scope)).toBe(value)
        expect(await cipher.open(value, scope)).toBe(value)
      }
    }
  })
})

describe('org transit key naming', () => {
  it('derives the org prefix from the deployment key so shared mounts stay separated', () => {
    expect(effectiveOrgKeyPrefix('cp-alpha')).toBe('cp-alpha-org-')
    // Two deployments on ONE transit mount must not collide on org keys.
    expect(effectiveOrgKeyPrefix('cp-alpha')).not.toBe(effectiveOrgKeyPrefix('cp-beta'))
  })

  it('an explicit prefix wins over the derived default', () => {
    expect(effectiveOrgKeyPrefix('deployment-key', 'tenant-')).toBe('tenant-')
  })

  it('refuses a deployment key that sits INSIDE the org namespace, and an empty prefix', () => {
    // Such a name is a shreddable name — destroying it takes the deployment's
    // whole trust root with it, irreversibly.
    expect(orgKeyPrefixConflict('ac-org-shared', 'ac-org-')).toMatch(/must not start with/)
    expect(orgKeyPrefixConflict('ac-cp', '')).toMatch(/must not be empty/)
    // The derived default can never conflict with its own deployment key.
    const key = 'cp-alpha'
    expect(orgKeyPrefixConflict(key, effectiveOrgKeyPrefix(key))).toBeNull()
  })
})
