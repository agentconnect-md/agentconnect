import { describe, expect, it } from 'vitest'
import { DeploymentConfigValuesV1Schema } from '../persistence/deployment-config.js'
import { DeploymentMemberSource, OrganizationMemberSource, resolveMemberSource } from './member-source.js'

const orgsOf = (ids: string[]) => ({
  listIds: async (limit: number) => ids.slice(0, limit),
  slugById: async (id: string) => (ids.includes(id) ? `slug-${id}` : null)
})
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

  const named = (memberOrganization: string | null, ids: string[], log = silent) =>
    new DeploymentMemberSource({
      connector: { memberSource: 'domain', domains: ['acme.example'], memberOrganization },
      orgs: orgsOf(ids),
      log
    })

  it('joins the configured organization among several', async () => {
    const source = named('org-2', ['org-1', 'org-2', 'org-3'])
    expect(await source.joinableOrg('acme.example')).toBe('org-2')
    expect(await source.target()).toBe('org-2')
  })

  it('joins nobody when the configured organization is gone, and says so once', async () => {
    const warnings: object[] = []
    const source = named('org-gone', ['org-1'], { warn: (obj: object) => warnings.push(obj) })
    expect(await source.joinableOrg('acme.example')).toBeNull()
    expect(await source.joinableOrg('acme.example')).toBeNull()
    expect(await source.target()).toBeNull()
    expect(warnings).toEqual([{ organizations: 'missing' }])
  })

  it('keeps the only-organization rule when none is configured', async () => {
    expect(await named(null, ['org-1']).target()).toBe('org-1')
    expect(await named(null, []).target()).toBeNull()
    expect(await named(null, ['org-1', 'org-2']).target()).toBeNull()
  })

  it('reports its target under invite too, while joining nobody', async () => {
    const source = new DeploymentMemberSource({
      connector: { memberSource: 'invite', domains: ['acme.example'], memberOrganization: 'org-2' },
      orgs: orgsOf(['org-1', 'org-2']),
      log: silent
    })
    expect(source.choice).toBe('invite')
    expect(await source.target()).toBe('org-2')
    expect(await source.joinableOrg('acme.example')).toBeNull()
  })

  it('reads a stored connector without an organization as null', () => {
    const connector = DeploymentConfigValuesV1Schema.shape.logto.unwrap().shape.ssoConnector.unwrap().unwrap()
    expect(connector.parse({ connectorId: 'c', protocol: 'oidc', name: 'SSO' }).memberOrganization).toBeNull()
  })
})
