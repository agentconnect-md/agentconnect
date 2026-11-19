import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DeploymentConfigValuesV1Schema,
  deploymentAdminClaimKey,
  type DeploymentConfigAdmin,
  type DeploymentConfigStore,
  type DeploymentSecretKey
} from '@agentconnect.md/control-plane/deployment-config-store'
import { SETUP_HTML } from '../src/server/html.js'
import { buildSetupServer } from '../src/server/index.js'
import { LogtoManagementError, type LogtoSetupDesired } from '../src/server/logto-management.js'

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
})
const headers = { authorization: 'Bearer admin' }

function server() {
  const admin: DeploymentConfigAdmin = {
    schemaVersion: 1,
    revision: 1,
    values: {
      ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
      auth: {
        mode: 'oidc',
        audience: 'browser-app',
        browserClient: { appId: 'browser-app', apiResource: null },
        socialProviders: ['google'],
        sso: null
      },
      logto: {
        managementAppId: 'management-app',
        managementResource: 'https://login.example.test/api',
        browser: { applicationName: 'AgentConnect', apiResource: null, socialProviders: ['google'] },
        githubConnector: null,
        googleConnector: { clientId: 'google-client' }
      }
    },
    secrets: [],
    adminClaimedFor: null,
    updatedAt: new Date('2026-11-04T00:00:00Z')
  }
  admin.adminClaimedFor = deploymentAdminClaimKey(admin.values, 'https://login.example.test/oidc')
  const secrets: Partial<Record<DeploymentSecretKey, string>> = {
    'logto.managementAppSecret': 'management-secret',
    'logto.googleConnectorClientSecret': 'google-secret'
  }
  const reconciled: LogtoSetupDesired[] = []
  const organizations = [
    { id: 'org-acme', name: 'Acme', slug: 'acme' },
    { id: 'org-ops', name: null, slug: 'ops' }
  ]
  const created: Array<{ providerName: string; displayName: string }> = []
  const logto = { deletions: 0, failDelete: false }
  const store: DeploymentConfigStore = {
    getAdmin: async () => admin,
    getRuntime: async (keys) => ({
      ...admin,
      secrets: Object.fromEntries(
        Object.entries(secrets).filter(([key]) => !keys || keys.includes(key as DeploymentSecretKey))
      )
    }),
    replace: async (input) => {
      expect(input.expectedRevision).toBe(admin.revision)
      admin.values = input.values
      admin.revision++
      for (const [key, value] of Object.entries(input.secrets ?? {})) {
        if (value === null) delete secrets[key as DeploymentSecretKey]
        else secrets[key as DeploymentSecretKey] = value
      }
      return admin
    },
    markAdminClaimed: async () => {}
  }
  const app = buildSetupServer({
    store,
    organizations: { list: async () => organizations },
    publicUrl: 'http://localhost:8091',
    localAuthBootstrap: {
      issuer: 'https://login.example.test/oidc',
      services: {
        web: 'https://console.example.test',
        controlPlane: 'https://api.example.test',
        relay: 'https://relay.example.test'
      }
    },
    verifyOidcToken: async (token) => ({ sub: 'operator', roles: token === 'admin' ? ['ADMIN'] : [] }),
    fetch: async () => new Response(null, { status: 404 }),
    makeLogtoSetupClient: () => ({
      reconcileSetup: async (desired) => {
        reconciled.push(desired)
        return {
          changed: true,
          application: { id: 'browser-app', created: false, changed: false },
          connectors: [],
          sso: desired.sso ? { id: desired.sso.connectorId, changed: true } : null,
          ssoConnectorsDeleted: [],
          signInExperienceChanged: true,
          tokenClaimsChanged: false,
          accountEmailChanged: false,
          adminRoleCreated: false
        }
      },
      createSsoConnector: async (input) => {
        created.push(input)
        return { id: 'sso-1', created: created.length === 1 }
      },
      deleteManagedSsoConnectors: async () => {
        if (logto.failDelete) throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto request failed: HTTP 500', 500)
        logto.deletions++
        return ['sso-1']
      }
    })
  })
  running = app
  return { app, admin, secrets, reconciled, created, logto, organizations }
}

const post = (app: FastifyInstance, url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> })

describe('SSO configuration', () => {
  it('creates the connector, takes the OIDC client, and signs in through it alone', async () => {
    const { app, admin, secrets, reconciled, created, logto } = server()
    expect((await post(app, '/api/v1/reconcile/logto', {})).statusCode).toBe(200)
    expect(reconciled.at(-1)?.ssoRemoved).toBe(true)

    const create = await post(app, '/api/v1/create/sso', { protocol: 'oidc', name: 'Example SSO' })
    expect(create.statusCode).toBe(200)
    expect(create.json()).toMatchObject({
      connectorId: 'sso-1',
      protocol: 'oidc',
      redirectUri: 'https://login.example.test/callback/sso-1'
    })
    expect(created).toEqual([{ providerName: 'OIDC', displayName: 'Example SSO' }])
    expect(admin.values.logto?.ssoConnector).toEqual({
      connectorId: 'sso-1',
      protocol: 'oidc',
      name: 'Example SSO',
      domains: [],
      memberSource: 'domain',
      memberOrganization: null,
      oidc: null,
      saml: null
    })
    // A retried create keeps the same connector and leaves the document alone.
    const revision = admin.revision
    expect((await post(app, '/api/v1/create/sso', { protocol: 'oidc', name: 'Example SSO' })).statusCode).toBe(200)
    expect(admin.revision).toBe(revision)

    // Without its IdP the connector is not a way in yet.
    admin.values.logto!.browser!.socialProviders = []
    const early = await post(app, '/api/v1/reconcile/logto', {})
    expect(early.statusCode).toBe(409)
    expect(early.json().detail ?? early.body).toContain('SSO connector')
    // A reconcile between the two steps keeps the connector being configured.
    admin.values.logto!.browser!.socialProviders = ['google']
    expect((await post(app, '/api/v1/reconcile/logto', {})).statusCode).toBe(200)
    expect(reconciled.at(-1)?.ssoRemoved).toBeUndefined()
    admin.values.logto!.browser!.socialProviders = []

    const oidc = { issuer: 'https://idp.example.test', clientId: 'client', trustUnverifiedEmail: true }
    const noSecret = await post(app, '/api/v1/configure/sso', {
      connector: { name: 'Example SSO', domains: ['Example.TEST'], oidc }
    })
    expect(noSecret.statusCode).toBe(400)

    const configure = await post(app, '/api/v1/configure/sso', {
      connector: { name: 'Example SSO', domains: ['Example.TEST'], oidc: { ...oidc, clientSecret: 'idp-secret' } }
    })
    expect(configure.statusCode).toBe(200)
    expect(configure.body).not.toContain('idp-secret')
    expect(secrets['logto.ssoConnectorClientSecret']).toBe('idp-secret')
    expect(admin.values.logto?.ssoConnector).toMatchObject({
      domains: ['example.test'],
      oidc: { issuer: 'https://idp.example.test', clientId: 'client', scope: '', trustUnverifiedEmail: true }
    })

    const reconcile = await post(app, '/api/v1/reconcile/logto', {})
    expect(reconcile.statusCode).toBe(200)
    expect(reconciled.at(-1)?.sso).toEqual({
      connectorId: 'sso-1',
      displayName: 'Example SSO',
      providerName: 'OIDC',
      domains: ['example.test'],
      config: {
        issuer: 'https://idp.example.test',
        clientId: 'client',
        clientSecret: 'idp-secret',
        trustUnverifiedEmail: true
      }
    })
    expect(admin.values.auth).toMatchObject({
      mode: 'oidc',
      socialProviders: [],
      sso: { connectorId: 'sso-1', name: 'Example SSO' }
    })

    // The last way in cannot be removed.
    expect((await post(app, '/api/v1/configure/sso', { connector: null })).statusCode).toBe(400)
    admin.values.logto!.browser!.socialProviders = ['google']
    expect(logto.deletions).toBe(0)
    // A failed delete in Logto leaves the document naming the connector that still lives.
    logto.failDelete = true
    const failed = await post(app, '/api/v1/configure/sso', { connector: null })
    expect(failed.statusCode).toBe(502)
    expect(admin.values.logto?.ssoConnector).toMatchObject({ connectorId: 'sso-1' })
    logto.failDelete = false
    expect((await post(app, '/api/v1/configure/sso', { connector: null })).statusCode).toBe(200)
    expect(logto.deletions).toBe(1)
    expect(admin.values.logto?.ssoConnector).toBeNull()
    expect(secrets['logto.ssoConnectorClientSecret']).toBeUndefined()
    await post(app, '/api/v1/reconcile/logto', {})
    expect(reconciled.at(-1)?.sso).toBeUndefined()
    expect(reconciled.at(-1)?.ssoRemoved).toBe(true)
    expect(admin.values.auth).toMatchObject({ socialProviders: ['google'], sso: null })
  })

  it('takes SAML metadata by URL and refuses settings for the other protocol', async () => {
    const { app, admin, reconciled } = server()
    const create = await post(app, '/api/v1/create/sso', { protocol: 'saml', name: 'Example SAML' })
    expect(create.json()).toMatchObject({
      assertionConsumerServiceUrl: 'https://login.example.test/api/authn/single-sign-on/saml/sso-1',
      entityId: 'https://login.example.test/enterprise-sso/sso-1'
    })
    expect(
      (
        await post(app, '/api/v1/configure/sso', {
          connector: {
            name: 'Example SAML',
            oidc: { issuer: 'https://idp.example.test', clientId: 'c', trustUnverifiedEmail: false }
          }
        })
      ).statusCode
    ).toBe(400)
    expect(
      (await post(app, '/api/v1/configure/sso', { connector: { name: 'Example SAML', saml: {} } })).statusCode
    ).toBe(400)
    const saml = { metadataUrl: 'https://idp.example.test/metadata', attributeMapping: { email: 'mail' } }
    // Without a domain Logto would silently refuse the connector at sign-in, so Setup refuses it here.
    const noDomain = await post(app, '/api/v1/configure/sso', { connector: { name: 'Example SAML', saml } })
    expect(noDomain.statusCode).toBe(400)
    expect(noDomain.body).toContain('email domain')
    const configure = (domains: string[]) =>
      post(app, '/api/v1/configure/sso', { connector: { name: 'Example SAML', domains, saml } })
    expect((await configure(['example.test'])).statusCode).toBe(200)
    expect((await post(app, '/api/v1/reconcile/logto', {})).statusCode).toBe(200)
    expect(reconciled.at(-1)?.sso).toMatchObject({
      providerName: 'SAML',
      config: { metadataUrl: 'https://idp.example.test/metadata', attributeMapping: { email: 'mail' } }
    })
    expect(admin.values.auth).toMatchObject({ socialProviders: ['google'], sso: { connectorId: 'sso-1' } })
  })

  it('saves the member source, keeps it when omitted, and reads a document without it as domain', async () => {
    const { app, admin } = server()
    await post(app, '/api/v1/create/sso', { protocol: 'saml', name: 'Example SAML' })
    const saml = { metadataUrl: 'https://idp.example.test/metadata' }
    const configure = (extra: Record<string, unknown>) =>
      post(app, '/api/v1/configure/sso', {
        connector: { name: 'Example SAML', domains: ['acme.example'], saml, ...extra }
      })
    expect((await configure({ memberSource: 'invite' })).statusCode).toBe(200)
    expect(admin.values.logto?.ssoConnector?.memberSource).toBe('invite')
    expect((await configure({})).statusCode).toBe(200)
    expect(admin.values.logto?.ssoConnector?.memberSource).toBe('invite')
    expect((await configure({ memberSource: 'everyone' })).statusCode).toBe(400)
    const { memberSource: _memberSource, ...legacy } = admin.values.logto!.ssoConnector!
    const parsed = DeploymentConfigValuesV1Schema.parse({
      ...admin.values,
      logto: { ...admin.values.logto, ssoConnector: legacy }
    })
    expect(parsed.logto?.ssoConnector?.memberSource).toBe('domain')
  })

  it('renders the New members control from the saved connector', () => {
    expect(SETUP_HTML).toContain('<option value="domain">Anyone who signs in with SSO</option>')
    expect(SETUP_HTML).toContain('<option value="invite">Invite only</option>')
    expect(SETUP_HTML).toContain("el(prefix + '-member-source').value = connector.memberSource || 'domain'")
    expect(SETUP_HTML).toContain("memberSource: el(prefix + '-member-source').value")
    expect(SETUP_HTML).toContain('<label class="field">Organization<select id="sso-member-organization">')
    expect(SETUP_HTML).toContain("memberOrganization: el(prefix + '-member-organization').value || null")
  })

  it('saves the organization, keeps it when omitted, clears it with null, and refuses an unknown one', async () => {
    const { app, admin, organizations } = server()
    await post(app, '/api/v1/create/sso', { protocol: 'saml', name: 'Example SAML' })
    const saml = { metadataUrl: 'https://idp.example.test/metadata' }
    const configure = (extra: Record<string, unknown>) =>
      post(app, '/api/v1/configure/sso', {
        connector: { name: 'Example SAML', domains: ['acme.example'], saml, ...extra }
      })
    const saved = () => admin.values.logto?.ssoConnector?.memberOrganization
    expect(saved()).toBeNull()
    expect((await configure({ memberOrganization: 'org-ops' })).statusCode).toBe(200)
    expect(saved()).toBe('org-ops')
    expect((await configure({})).statusCode).toBe(200)
    expect(saved()).toBe('org-ops')
    const unknown = await configure({ memberOrganization: 'org-unknown' })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.body).toContain('organization does not exist')
    // A saved organization that has since gone can be kept while the rest is edited.
    organizations.splice(1, 1)
    expect((await configure({ memberOrganization: 'org-ops' })).statusCode).toBe(200)
    expect((await configure({ memberOrganization: null })).statusCode).toBe(200)
    expect(saved()).toBeNull()

    const status = await app.inject({ method: 'GET', url: '/api/v1/deployment-config', headers })
    expect(status.json().organizations).toEqual([{ id: 'org-acme', name: 'Acme', slug: 'acme' }])
  })

  it('lists the organizations in the control, shows a gone one as missing, and disables it while invite only', () => {
    const source =
      /function renderMemberOrganizations[\s\S]*?\n {4}}\n\n {4}function updateMemberOrganization[\s\S]*?\n {4}}\n/.exec(
        SETUP_HTML
      )![0]
    class FakeElement {
      children: FakeElement[] = []
      textContent = ''
      disabled = false
      private current = ''
      get value(): string {
        return this.current
      }
      set value(next: string) {
        this.current = this.children.length === 0 || this.children.some((c) => c.value === next) ? next : ''
      }
      replaceChildren() {
        this.children = []
      }
      append(child: FakeElement) {
        this.children.push(child)
      }
    }
    const elements: Record<string, FakeElement> = {
      'sso-member-organization': new FakeElement(),
      'sso-member-source': new FakeElement()
    }
    const run = new Function(
      'el',
      'document',
      'orgs',
      `let ssoOrganizations = orgs;\n${source}\nreturn renderMemberOrganizations;`
    ) as (
      el: (id: string) => FakeElement,
      document: { createElement(): FakeElement },
      orgs: unknown[]
    ) => (prefix: string, selected: string) => void
    const render = run((id) => elements[id]!, { createElement: () => new FakeElement() }, [
      { id: 'org-acme', name: 'Acme', slug: 'acme' },
      { id: 'org-ops', name: null, slug: 'ops' }
    ])
    const select = elements['sso-member-organization']!
    const labels = () => select.children.map((c) => `${c.value}=${c.textContent}`)

    elements['sso-member-source']!.value = 'domain'
    render('sso', 'org-ops')
    expect(labels()).toEqual(['=The only organization', 'org-acme=Acme (acme)', 'org-ops=ops (ops)'])
    expect(select.value).toBe('org-ops')
    expect(select.disabled).toBe(false)

    render('sso', 'org-gone')
    expect(labels().at(-1)).toBe('org-gone=Missing organization (org-gone)')
    expect(select.value).toBe('org-gone')

    elements['sso-member-source']!.value = 'invite'
    render('sso', '')
    expect(select.value).toBe('')
    expect(select.disabled).toBe(true)
  })
})
