/** What a console user's linked sign-in methods say about an address is read from the identity provider and handed to the repository. */
import { describe, expect, it, vi } from 'vitest'
import { syncEmailVerification, verifyingConnectorId } from './email-verification.js'

type Identity = { connectorId: string; email?: string }

function deps(input: { social?: string[]; sso?: Identity[]; verifyingConnectorId?: string | null }) {
  const recordEmailEvidence = vi.fn(async () => {})
  const ssoIdentitiesFor = vi.fn(async () => input.sso ?? [])
  return {
    recordEmailEvidence,
    ssoIdentitiesFor,
    deps: {
      identity: { socialEmailsFor: async () => input.social ?? [], ssoIdentitiesFor },
      users: { recordEmailEvidence },
      clock: { now: () => 1_000 },
      verifyingConnectorId: input.verifyingConnectorId
    }
  }
}

const SUBJECT = { userId: 'user-1', oidcSubject: 'subject-1' }
const AT = new Date(1_000)

describe('syncEmailVerification', () => {
  it('reports a social address as verified, stamped with the clock', async () => {
    const h = deps({ social: ['someone@example.test'] })

    await syncEmailVerification(h.deps, SUBJECT)
    expect(h.recordEmailEvidence).toHaveBeenCalledWith(
      'user-1',
      { verified: ['someone@example.test'], asserted: [] },
      AT
    )
  })

  it('reports an address a connector asserts without calling it verified, read past the cache', async () => {
    const h = deps({ sso: [{ connectorId: 'connector-org', email: 'member@example.test' }, { connectorId: 'bare' }] })

    await syncEmailVerification(h.deps, SUBJECT)
    expect(h.ssoIdentitiesFor).toHaveBeenCalledWith('subject-1', true)
    expect(h.recordEmailEvidence).toHaveBeenCalledWith(
      'user-1',
      { verified: [], asserted: [{ connectorId: 'connector-org', email: 'member@example.test' }] },
      AT
    )
  })

  it('counts the deployment connector’s address as verified only when it is the verifying connector', async () => {
    const sso = [{ connectorId: 'connector-deployment', email: 'member@example.test' }]
    const off = deps({ sso, verifyingConnectorId: 'connector-deployment' })
    const on = deps({ sso, verifyingConnectorId: null })

    await syncEmailVerification(off.deps, SUBJECT)
    await syncEmailVerification(on.deps, SUBJECT)
    expect(off.recordEmailEvidence).toHaveBeenCalledWith(
      'user-1',
      { verified: ['member@example.test'], asserted: sso },
      AT
    )
    expect(on.recordEmailEvidence).toHaveBeenCalledWith('user-1', { verified: [], asserted: sso }, AT)
  })

  it('reports nothing for an account with no linked method, which drops what was recorded', async () => {
    const h = deps({})

    await syncEmailVerification(h.deps, SUBJECT)
    expect(h.recordEmailEvidence).toHaveBeenCalledWith('user-1', { verified: [], asserted: [] }, AT)
  })

  it('writes nothing when the identity provider cannot be read', async () => {
    const h = deps({})
    h.ssoIdentitiesFor.mockRejectedValueOnce(new Error('identity provider unavailable'))

    await expect(syncEmailVerification(h.deps, SUBJECT)).rejects.toThrow()
    expect(h.recordEmailEvidence).not.toHaveBeenCalled()
  })
})

describe('verifyingConnectorId', () => {
  const oidc = (trustUnverifiedEmail: boolean) =>
    ({ connectorId: 'connector-deployment', protocol: 'oidc', oidc: { trustUnverifiedEmail } }) as const

  it('names an OIDC connector that does not trust unverified addresses', () => {
    expect(verifyingConnectorId(oidc(false))).toBe('connector-deployment')
  })

  it('names none when the connector trusts unverified addresses, is SAML, is not configured, or is absent', () => {
    expect(verifyingConnectorId(oidc(true))).toBeNull()
    expect(verifyingConnectorId({ connectorId: 'connector-deployment', protocol: 'saml', oidc: null })).toBeNull()
    expect(verifyingConnectorId({ connectorId: 'connector-deployment', protocol: 'oidc', oidc: null })).toBeNull()
    expect(verifyingConnectorId(null)).toBeNull()
    expect(verifyingConnectorId(undefined)).toBeNull()
  })
})
