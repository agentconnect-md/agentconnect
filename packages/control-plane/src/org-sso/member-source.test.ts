import { describe, expect, it } from 'vitest'
import { DeploymentConfigValuesV1Schema } from '../persistence/deployment-config.js'
import { DeploymentMemberSource, OrganizationMemberSource, resolveMemberSource } from './member-source.js'

const orgsOf = (ids: string[]) => ({ listIds: async (limit: number) => ids.slice(0, limit) })
const silent: { warn(obj: object): void } = { warn: () => {} }
const organizationDomains = { joinableOrg: async (domain: string) => (domain === 'org.example' ? 'org-a' : null) }

describe('resolveMemberSource', () => {
  it('uses the deployment connector when the deployment declares one', async () => {
    const source = resolveMemberSource({
      deploymentConnector: { memberSource: 'domain', domains: ['acme.example'] },
      organizationDomains,
      orgs: orgsOf(['org-1']),
      log: silent
    })
    expect(source).toBeInstanceOf(DeploymentMemberSource)
    expect(await source!.joinableOrg('acme.example')).toBe('org-1')
    expect(await source!.joinableOrg('org.example')).toBeNull()
  })

  it('falls back to the organizations’ own connections, and to none', async () => {
    const source = resolveMemberSource({
      deploymentConnector: null,
      organizationDomains,
      orgs: orgsOf([]),
      log: silent
    })
    expect(source).toBeInstanceOf(OrganizationMemberSource)
    expect(await source!.joinableOrg('org.example')).toBe('org-a')
    expect(
      resolveMemberSource({
        deploymentConnector: undefined,
        organizationDomains: undefined,
        orgs: orgsOf([]),
        log: silent
      })
    ).toBeUndefined()
  })

  it('reads a stored connector without a member source as domain', () => {
    const connector = DeploymentConfigValuesV1Schema.shape.logto.unwrap().shape.ssoConnector.unwrap().unwrap()
    expect(connector.parse({ connectorId: 'c', protocol: 'oidc', name: 'SSO' }).memberSource).toBe('domain')
  })
})

describe('DeploymentMemberSource', () => {
  const source = (memberSource: 'invite' | 'domain', ids: string[], log = silent) =>
    new DeploymentMemberSource({ connector: { memberSource, domains: ['Acme.Example'] }, orgs: orgsOf(ids), log })

  it('matches a domain exactly and case-insensitively', async () => {
    expect(await source('domain', ['org-1']).joinableOrg('acme.example')).toBe('org-1')
    expect(await source('domain', ['org-1']).joinableOrg('ACME.EXAMPLE')).toBe('org-1')
    expect(await source('domain', ['org-1']).joinableOrg('sub.acme.example')).toBeNull()
    expect(await source('domain', ['org-1']).joinableOrg('other.example')).toBeNull()
  })

  it('joins nobody when invite only', async () => {
    expect(await source('invite', ['org-1']).joinableOrg('acme.example')).toBeNull()
  })

  it('joins nobody unless the deployment has exactly one organization, and warns once', async () => {
    const warnings: object[] = []
    const log = { warn: (obj: object) => warnings.push(obj) }
    const none = source('domain', [], log)
    expect(await none.joinableOrg('acme.example')).toBeNull()
    expect(await none.joinableOrg('acme.example')).toBeNull()
    expect(warnings).toEqual([{ organizations: 'none' }])
    expect(await source('domain', ['org-1', 'org-2'], log).joinableOrg('acme.example')).toBeNull()
    expect(warnings.at(-1)).toEqual({ organizations: 'several' })
  })
})
