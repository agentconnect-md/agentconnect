import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DeploymentConfigValuesV1Schema,
  deploymentSecretsRequiringRefresh,
  type DeploymentConfigValuesV1
} from './deployment-config.js'

const base: DeploymentConfigValuesV1 = {
  ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  github: { appId: 1, slug: 'agentconnect', clientId: 'Iv1.first' },
  slack: { appId: 'A1', clientId: '1.1' },
  logto: {
    managementAppId: 'm2m-1',
    managementResource: 'https://default.logto.app/api',
    browser: null,
    githubConnector: null
  }
}

describe('DeploymentConfigValuesV1Schema', () => {
  it('defaults the non-admin organization quota and accepts zero', () => {
    const legacy = DeploymentConfigValuesV1Schema.parse({
      ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
      features: { presetAgentsEnabled: true }
    })
    expect(legacy.features.maxOrgsPerNonAdminUser).toBe(1)

    const zero = DeploymentConfigValuesV1Schema.parse({
      ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
      features: { presetAgentsEnabled: true, maxOrgsPerNonAdminUser: 0 }
    })
    expect(zero.features.maxOrgsPerNonAdminUser).toBe(0)
  })

  it('accepts the Teams home tenant lower-cased and refuses a non-GUID', () => {
    const msTeams = { tenantId: '44444444-4444-4444-8444-444444444444' }
    expect(DeploymentConfigValuesV1Schema.parse({ ...base, msTeams }).msTeams).toEqual({
      tenantId: '44444444-4444-4444-8444-444444444444'
    })
    expect(
      DeploymentConfigValuesV1Schema.safeParse({
        ...base,
        msTeams: { ...msTeams, tenantId: 'example.onmicrosoft.com' }
      }).success
    ).toBe(false)
  })

  it('accepts agent bots beside the Teams app and refuses a malformed resource group', () => {
    const tenantId = '44444444-4444-4444-8444-444444444444'
    const agentBots = {
      blueprintId: '55555555-5555-4555-8555-55555555555A',
      subscriptionId: '66666666-6666-4666-8666-666666666666',
      resourceGroup: ' example-bots_(1) '
    }
    const parsed = DeploymentConfigValuesV1Schema.parse({ ...base, msTeams: { tenantId, agentBots } })
    expect(parsed.msTeams?.agentBots).toEqual({
      blueprintId: '55555555-5555-4555-8555-55555555555a',
      subscriptionId: '66666666-6666-4666-8666-666666666666',
      resourceGroup: 'example-bots_(1)'
    })
    for (const resourceGroup of ['', 'ends-in-a-period.', 'has a space', 'x'.repeat(91)])
      expect(
        DeploymentConfigValuesV1Schema.safeParse({
          ...base,
          msTeams: { tenantId, agentBots: { ...agentBots, resourceGroup } }
        }).success
      ).toBe(false)
    // Another blueprint needs its own secret; a moved resource group does not.
    const before = DeploymentConfigValuesV1Schema.parse({ ...base, msTeams: { tenantId } })
    expect(deploymentSecretsRequiringRefresh(before, parsed)).toEqual(['msTeams.blueprintClientSecret'])
    const moved = {
      ...parsed,
      msTeams: { tenantId, agentBots: { ...parsed.msTeams!.agentBots!, resourceGroup: 'other' } }
    }
    expect(deploymentSecretsRequiringRefresh(parsed, moved)).toEqual([])
  })

  it('accepts a Google Chat project and refuses a non-numeric project number', () => {
    const googleChat = { projectId: 'example-project', projectNumber: '123456789012' }
    expect(DeploymentConfigValuesV1Schema.parse({ ...base, googleChat }).googleChat).toEqual(googleChat)
    expect(
      DeploymentConfigValuesV1Schema.safeParse({ ...base, googleChat: { ...googleChat, projectNumber: '12ab' } })
        .success
    ).toBe(false)
    expect(
      DeploymentConfigValuesV1Schema.safeParse({ ...base, googleChat: { ...googleChat, projectId: 'Not A Project' } })
        .success
    ).toBe(false)
  })

  it('accepts a Microsoft login application and refuses an empty client ID', () => {
    const azureadConnector = { clientId: '00000000-0000-4000-8000-0000000000c1' }
    expect(
      DeploymentConfigValuesV1Schema.parse({ ...base, logto: { ...base.logto, azureadConnector } }).logto
        ?.azureadConnector
    ).toEqual(azureadConnector)
    expect(
      DeploymentConfigValuesV1Schema.safeParse({
        ...base,
        logto: { ...base.logto, azureadConnector: { clientId: ' ' } }
      }).success
    ).toBe(false)
  })

  const oidcAuth = {
    mode: 'oidc' as const,
    audience: 'web-app',
    browserClient: { appId: 'web-app', apiResource: null }
  }

  it('lets an SSO connector stand in for every social provider', () => {
    const sso = { connectorId: 'sso-1', name: 'Example SSO' }
    expect(
      DeploymentConfigValuesV1Schema.parse({ ...base, auth: { ...oidcAuth, socialProviders: [], sso } }).auth
    ).toEqual({ ...oidcAuth, socialProviders: [], sso })
    expect(
      DeploymentConfigValuesV1Schema.parse({ ...base, auth: { ...oidcAuth, socialProviders: ['github'] } }).auth
    ).toEqual({ ...oidcAuth, socialProviders: ['github'], sso: null })
    expect(
      DeploymentConfigValuesV1Schema.safeParse({ ...base, auth: { ...oidcAuth, socialProviders: [] } }).success
    ).toBe(false)
  })

  it('keeps one protocol per SSO connector and lower-cases its domains', () => {
    const oidc = { issuer: 'https://idp.example.test', clientId: 'client' }
    const parsed = DeploymentConfigValuesV1Schema.parse({
      ...base,
      logto: {
        ...base.logto,
        ssoConnector: { connectorId: 'sso-1', protocol: 'oidc', name: 'Example SSO', domains: ['Example.TEST'], oidc }
      }
    }).logto?.ssoConnector
    expect(parsed).toEqual({
      connectorId: 'sso-1',
      protocol: 'oidc',
      name: 'Example SSO',
      domains: ['example.test'],
      oidc: { ...oidc, scope: '', trustUnverifiedEmail: false },
      saml: null
    })
    const withSso = (ssoConnector: object) =>
      DeploymentConfigValuesV1Schema.safeParse({ ...base, logto: { ...base.logto, ssoConnector } }).success
    const saml = { connectorId: 'sso-1', protocol: 'saml', name: 'Example SSO', domains: ['example.test'] }
    const metadataUrl = 'https://idp.example.test/metadata'
    expect(withSso({ ...saml, oidc })).toBe(false)
    expect(withSso({ ...saml, saml: { metadataUrl } })).toBe(true)
    // Logto offers no sign-in through a connector without a domain, so the IdP needs one with it.
    expect(withSso({ ...saml, domains: [], saml: { metadataUrl } })).toBe(false)
    expect(withSso({ ...saml, domains: [] })).toBe(true)
    expect(withSso({ ...saml, saml: {} })).toBe(false)
    expect(withSso({ ...saml, saml: { metadataUrl: 'https://idp.example.test/m', metadata: '<xml/>' } })).toBe(false)
    expect(withSso({ ...saml, domains: ['not a domain'] })).toBe(false)
  })
})

describe('deploymentSecretsRequiringRefresh', () => {
  it('binds the SSO client secret to its issuer and client ID', () => {
    const withOidc = (issuer: string, clientId: string) =>
      DeploymentConfigValuesV1Schema.parse({
        ...base,
        logto: {
          ...base.logto,
          ssoConnector: {
            connectorId: 'sso-1',
            protocol: 'oidc',
            name: 'Example SSO',
            domains: ['example.test'],
            oidc: { issuer, clientId }
          }
        }
      })
    const first = withOidc('https://idp.example.test', 'client')
    expect(deploymentSecretsRequiringRefresh(base, first)).toEqual(['logto.ssoConnectorClientSecret'])
    expect(deploymentSecretsRequiringRefresh(first, first)).toEqual([])
    expect(deploymentSecretsRequiringRefresh(first, withOidc('https://other.example.test', 'client'))).toEqual([
      'logto.ssoConnectorClientSecret'
    ])
  })

  it.each(['telegram', 'discord', 'azuread'] as const)('binds the %s login secret to its client ID', (provider) => {
    const key = `${provider}Connector` as const
    const next = DeploymentConfigValuesV1Schema.parse({
      ...base,
      logto: { ...base.logto, [key]: { clientId: 'login-client' } }
    })
    expect(deploymentSecretsRequiringRefresh(base, next)).toEqual([`logto.${provider}ConnectorClientSecret`])
    expect(deploymentSecretsRequiringRefresh(next, next)).toEqual([])
  })

  it('binds write-only secrets only to provider identity fields', () => {
    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        github: { ...base.github!, slug: 'renamed' },
        logto: { ...base.logto!, managementResource: 'https://custom.example.test/api' }
      })
    ).toEqual([])
    expect(deploymentSecretsRequiringRefresh(base, { ...base, github: null })).toEqual([])
    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        logto: {
          ...base.logto!,
          githubConnector: {
            appId: 3,
            slug: 'agentconnect-login',
            clientId: 'Iv1.login'
          }
        }
      })
    ).toEqual(['logto.githubConnectorClientSecret'])
    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        logto: {
          ...base.logto!,
          googleConnector: {
            clientId: 'google-client'
          }
        }
      })
    ).toEqual(['logto.googleConnectorClientSecret'])
    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        logto: {
          ...base.logto!,
          slackConnector: { appId: 'A1', clientId: '1.1' }
        }
      })
    ).toEqual([])

    expect(
      deploymentSecretsRequiringRefresh(base, {
        ...base,
        feishu: { loginAppId: 'cli_feishu' },
        lark: { loginAppId: 'cli_lark' },
        github: { appId: 2, slug: 'renamed', clientId: 'Iv1.second' },
        slack: { appId: 'A2', clientId: '2.2' },
        logto: { ...base.logto!, managementAppId: 'm2m-2' }
      })
    ).toEqual([
      'github.privateKeyB64',
      'github.webhookSecret',
      'github.clientSecret',
      'slack.clientSecret',
      'slack.signingSecret',
      'feishu.loginAppSecret',
      'lark.loginAppSecret',
      'logto.managementAppSecret'
    ])
  })

  it('asks for a new Google Chat key only when the project changes', () => {
    const withChat = { ...base, googleChat: { projectId: 'example-project', projectNumber: '123456789012' } }
    expect(deploymentSecretsRequiringRefresh(base, withChat)).toEqual(['googleChat.serviceAccountKey'])
    expect(
      deploymentSecretsRequiringRefresh(withChat, {
        ...withChat,
        googleChat: { projectId: 'example-project', projectNumber: '210987654321' }
      })
    ).toEqual([])
    expect(
      deploymentSecretsRequiringRefresh(withChat, {
        ...withChat,
        googleChat: { projectId: 'other-example-project', projectNumber: '123456789012' }
      })
    ).toEqual(['googleChat.serviceAccountKey'])
  })
})
