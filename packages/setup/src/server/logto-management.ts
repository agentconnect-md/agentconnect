/** Minimal Logto Management API client for setup reconciliation and ADMIN claim. */
import { LOGTO_GITHUB_CONNECTOR_ID, LOGTO_GOOGLE_CONNECTOR_ID, LOGTO_SLACK_CONNECTOR_ID } from '../logto-connectors.js'
import { ADMIN_ROLE } from './auth.js'

const MANAGED_APP_TAG = 'agentconnectSetup'
const MANAGED_APP_TAG_VALUE = { version: 1, resource: 'browser' } as const

/**
 * Logto Cloud seeds new tenants with demo connectors that sit on real social targets such as
 * `github` and `google`. Logto treats them as read-only fixtures: `GET` and `PATCH
 * /api/connectors/:id` both answer 404, the listing hides their config, and creating the real
 * connector fails with 422 `connector.multiple_target_with_same_platform` while one still holds
 * the target. So a demo connector is never a connector we can adopt — it is an obstacle to remove
 * before the managed one is created. `isDemo` is Logto's own flag; the id list is the fallback for
 * deployments whose Logto predates it.
 */
const DEMO_CONNECTOR_IDS: readonly string[] = ['logto-social-demo', 'logto-sms']

export interface LogtoManagementConfig {
  endpoint: string
  appId: string
  appSecret: string
  resource: string
}

export interface LogtoSetupDesired {
  applicationId?: string
  applicationName: string
  redirectUris: readonly string[]
  postLogoutRedirectUris: readonly string[]
  socialProviders: readonly string[]
  github?: { clientId: string; clientSecret: string }
  google?: { clientId: string; clientSecret: string }
  slack?: { clientId: string; clientSecret: string; scope: string }
}

interface LogtoRole {
  id: string
  name: string
  type: 'User' | 'MachineToMachine'
  isDefault: boolean
}

interface LogtoApplication {
  id: string
  name: string
  type: string
  oidcClientMetadata: Record<string, unknown>
  customData: Record<string, unknown>
}

interface LogtoConnector {
  id: string
  connectorId: string
  target: string
  name: string | null
  isDemo: boolean
  config: Record<string, unknown>
}

interface LogtoSignInExperience {
  signIn: Record<string, unknown>
  signUp: Record<string, unknown>
  socialSignInConnectorTargets: string[]
  signInMode: unknown
}

type ManagedConnectorTarget = 'github' | 'google' | 'slack'

function isManagedConnectorTarget(target: string): target is ManagedConnectorTarget {
  return target === 'github' || target === 'google' || target === 'slack'
}

export interface LogtoAdminRoleInspection {
  exists: boolean
  type: LogtoRole['type'] | null
  isDefault: boolean | null
}

export interface LogtoNamedConnector {
  id: string
  connectorId: string
  target: string
  name: string
  clientId: string | null
}

export interface LogtoConfigurationDiff {
  field: string
  current: unknown
  expected: unknown
}

export interface LogtoSetupInspection {
  application: { id: string | null; exists: boolean; matches: boolean; diff: LogtoConfigurationDiff[] }
  connectors: Array<{
    target: string
    id: string | null
    exists: boolean
    matches: boolean
    diff: LogtoConfigurationDiff[]
  }>
  signInExperienceMatches: boolean
  signInExperienceDiff: LogtoConfigurationDiff[]
}

export interface LogtoSetupReconcileResult {
  changed: boolean
  application: { id: string; created: boolean; changed: boolean }
  connectors: Array<{ target: string; id: string; created: boolean; changed: boolean }>
  signInExperienceChanged: boolean
  adminRoleCreated: boolean
}

export interface LogtoSetupReconcileOptions {
  /** Explicit secret replacement cannot be verified through Logto's masked read response. */
  refreshConnectorSecrets?: boolean
}

export class LogtoManagementError extends Error {
  constructor(
    readonly code:
      | 'LOGTO_UNAVAILABLE'
      | 'ADMIN_ROLE_TYPE_INVALID'
      | 'APPLICATION_TYPE_INVALID'
      | 'MANAGED_APPLICATION_AMBIGUOUS'
      | 'SOCIAL_CONNECTOR_AMBIGUOUS'
      | 'GITHUB_CONNECTOR_CREDENTIALS_REQUIRED'
      | 'GOOGLE_CONNECTOR_CREDENTIALS_REQUIRED'
      | 'SLACK_CONNECTOR_CREDENTIALS_REQUIRED'
      | 'SOCIAL_CONNECTOR_UNSUPPORTED',
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'LogtoManagementError'
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sameStrings(left: unknown, right: readonly string[]): boolean {
  return JSON.stringify(stringArray(left)) === JSON.stringify(right)
}

function containsStrings(current: unknown, required: readonly string[]): boolean {
  const values = new Set(stringArray(current))
  return required.every((value) => values.has(value))
}

function mergeStrings(current: unknown, required: readonly string[]): string[] {
  return [...new Set([...stringArray(current), ...required])]
}

function addDiff(
  diff: LogtoConfigurationDiff[],
  field: string,
  current: unknown,
  expected: unknown,
  matches: boolean = JSON.stringify(current) === JSON.stringify(expected)
): void {
  if (!matches) diff.push({ field, current: current ?? null, expected: expected ?? null })
}

function hasManagedTag(application: LogtoApplication): boolean {
  const tag = asRecord(application.customData[MANAGED_APP_TAG])
  return tag.version === MANAGED_APP_TAG_VALUE.version && tag.resource === MANAGED_APP_TAG_VALUE.resource
}

function parseApplication(value: unknown): LogtoApplication {
  const row = asRecord(value)
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.type !== 'string') {
    throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned an invalid application')
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    oidcClientMetadata: asRecord(row.oidcClientMetadata),
    customData: asRecord(row.customData)
  }
}

function parseConnector(value: unknown): LogtoConnector | null {
  const row = asRecord(value)
  const metadata = asRecord(row.metadata)
  const target = typeof row.target === 'string' ? row.target : metadata.target
  if (typeof row.id !== 'string' || typeof row.connectorId !== 'string' || typeof target !== 'string') return null
  const name = asRecord(row.name).en ?? asRecord(metadata.name).en
  return {
    id: row.id,
    connectorId: row.connectorId,
    target,
    name: typeof name === 'string' ? name : null,
    isDemo: row.isDemo === true || DEMO_CONNECTOR_IDS.includes(row.connectorId),
    config: asRecord(row.config)
  }
}

function desiredConnector(
  target: ManagedConnectorTarget,
  desired: LogtoSetupDesired
): { id: string; connectorId: string; config: Record<string, string> } {
  if (target === 'github') {
    if (!desired.github) {
      throw new LogtoManagementError(
        'GITHUB_CONNECTOR_CREDENTIALS_REQUIRED',
        'the Logto GitHub connector needs the deployment GitHub App client id and secret'
      )
    }
    return { id: LOGTO_GITHUB_CONNECTOR_ID, connectorId: 'github-universal', config: desired.github }
  }
  if (target === 'google') {
    if (!desired.google) {
      throw new LogtoManagementError(
        'GOOGLE_CONNECTOR_CREDENTIALS_REQUIRED',
        'the Logto Google connector needs a Google OAuth client id and secret'
      )
    }
    return { id: LOGTO_GOOGLE_CONNECTOR_ID, connectorId: 'google-universal', config: desired.google }
  }
  if (target === 'slack') {
    if (!desired.slack) {
      throw new LogtoManagementError(
        'SLACK_CONNECTOR_CREDENTIALS_REQUIRED',
        'the Logto Slack connector needs the deployment Slack App client id and secret'
      )
    }
    return { id: LOGTO_SLACK_CONNECTOR_ID, connectorId: 'slack-universal', config: desired.slack }
  }
  throw new Error(`unsupported managed Logto connector target: ${target}`)
}

function connectorMatches(connector: LogtoConnector, desired: ReturnType<typeof desiredConnector>): boolean {
  return (
    connector.connectorId === desired.connectorId &&
    connector.config.clientId === desired.config.clientId &&
    (desired.connectorId !== 'slack-universal' || connector.config.scope === desired.config.scope)
  )
}

function selectConnector(connectors: readonly LogtoConnector[], target: string): LogtoConnector | undefined {
  const matches = connectors.filter((connector) => !connector.isDemo && connector.target === target)
  if (matches.length <= 1) return matches[0]
  throw new LogtoManagementError(
    'SOCIAL_CONNECTOR_AMBIGUOUS',
    `Logto has more than one social connector for target ${target}`
  )
}

function selectConnectorByName(connectors: readonly LogtoConnector[], name: string): LogtoConnector | undefined {
  const normalized = name.trim().toLocaleLowerCase('en-US')
  const matches = connectors.filter(
    (connector) => !connector.isDemo && connector.name?.trim().toLocaleLowerCase('en-US') === normalized
  )
  if (matches.length <= 1) return matches[0]
  throw new LogtoManagementError('SOCIAL_CONNECTOR_AMBIGUOUS', `Logto has more than one social connector named ${name}`)
}

/** Demo connectors holding a social target we need. They block creation and cannot be patched. */
function selectDemoConnectors(connectors: readonly LogtoConnector[], target: string): LogtoConnector[] {
  return connectors.filter((connector) => connector.isDemo && connector.target === target)
}

export class LogtoAdminClaimClient {
  private readonly base: string
  private readonly resource: string
  private token: { value: string; expiresAt: number } | undefined
  private tokenRequest: Promise<string> | undefined
  private assignmentTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: LogtoManagementConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = 5_000
  ) {
    this.base = config.endpoint.replace(/\/+$/, '')
    this.resource = config.resource
  }

  /** Ensure the exact global User role `ADMIN` exists and assign the current subject. */
  assignAdmin(subject: string): Promise<void> {
    const assignment = this.assignmentTail.then(() => this.assign(subject))
    this.assignmentTail = assignment.catch(() => undefined)
    return assignment
  }

  /** Validate only the M2M grant. Never returns the access token. */
  async verifyClientCredentials(): Promise<void> {
    await this.accessToken()
  }

  /** Resolve provider callback IDs from Logto. These are remote identities, not deployment configuration. */
  async resolveConnectorIds(targets: readonly string[]): Promise<Record<string, string>> {
    const connectors = await this.listConnectors()
    return Object.fromEntries(
      targets.flatMap((target) => {
        const connector = selectConnector(connectors, target)
        return connector ? [[target, connector.id]] : []
      })
    )
  }

  /** Resolve standard OAuth connectors whose targets are not unique. */
  async resolveConnectorsByName(names: readonly string[]): Promise<Record<string, LogtoNamedConnector>> {
    const connectors = await this.listConnectors()
    return Object.fromEntries(
      names.flatMap((name) => {
        const connector = selectConnectorByName(connectors, name)
        if (!connector) return []
        return [
          [
            name,
            {
              id: connector.id,
              connectorId: connector.connectorId,
              target: connector.target,
              name,
              clientId: typeof connector.config.clientId === 'string' ? connector.config.clientId : null
            }
          ]
        ]
      })
    )
  }

  /** Read roles without mutating Logto and report the exact ADMIN role. */
  async inspectAdminRole(): Promise<LogtoAdminRoleInspection> {
    const role = (await this.listRoles()).find((candidate) => candidate.name === ADMIN_ROLE)
    return role
      ? { exists: true, type: role.type, isDefault: role.isDefault }
      : { exists: false, type: null, isDefault: null }
  }

  async inspectSetup(desired: LogtoSetupDesired): Promise<LogtoSetupInspection> {
    const application = await this.findApplication(desired.applicationId)
    const connectors = await this.listConnectors()
    const signInExperience = await this.getSignInExperience()
    const applicationDiff: LogtoConfigurationDiff[] = []
    if (!application) {
      applicationDiff.push({
        field: 'SPA application',
        current: 'Missing',
        expected: desired.applicationId ?? desired.applicationName
      })
    } else {
      addDiff(
        applicationDiff,
        'Redirect URIs',
        stringArray(application.oidcClientMetadata.redirectUris),
        desired.redirectUris,
        containsStrings(application.oidcClientMetadata.redirectUris, desired.redirectUris)
      )
      addDiff(
        applicationDiff,
        'Post sign-out redirect URIs',
        stringArray(application.oidcClientMetadata.postLogoutRedirectUris),
        desired.postLogoutRedirectUris,
        containsStrings(application.oidcClientMetadata.postLogoutRedirectUris, desired.postLogoutRedirectUris)
      )
    }
    const signInExperienceDiff: LogtoConfigurationDiff[] = []
    addDiff(signInExperienceDiff, 'Sign-in methods', signInExperience.signIn.methods ?? null, [])
    addDiff(signInExperienceDiff, 'Sign-up identifiers', signInExperience.signUp.identifiers ?? null, [])
    addDiff(signInExperienceDiff, 'Secondary identifiers', signInExperience.signUp.secondaryIdentifiers ?? [], [])
    addDiff(signInExperienceDiff, 'Password sign-up', signInExperience.signUp.password ?? null, false)
    addDiff(signInExperienceDiff, 'Sign-up verification', signInExperience.signUp.verify ?? null, false)
    addDiff(
      signInExperienceDiff,
      'Social providers',
      signInExperience.socialSignInConnectorTargets,
      desired.socialProviders,
      sameStrings(signInExperience.socialSignInConnectorTargets, desired.socialProviders)
    )
    addDiff(signInExperienceDiff, 'Sign-in mode', signInExperience.signInMode ?? null, 'SignInAndRegister')
    return {
      application: {
        id: application?.id ?? null,
        exists: application !== undefined,
        matches: application ? this.applicationMatches(application, desired) : false,
        diff: applicationDiff
      },
      connectors: desired.socialProviders.map((target) => {
        // A Logto Cloud demo connector on this target is not the connector we want; report it so
        // the operator sees why the target reads as missing and what reconciliation will remove.
        const demos = selectDemoConnectors(connectors, target).map((demo): LogtoConfigurationDiff => ({
          field: `${target} demo connector`,
          current: demo.name ?? demo.connectorId,
          expected: 'Removed'
        }))
        if (!isManagedConnectorTarget(target)) {
          const connector = selectConnector(connectors, target)
          return {
            target,
            id: connector?.id ?? null,
            exists: connector !== undefined,
            matches: connector !== undefined,
            diff: connector
              ? demos
              : [...demos, { field: `${target} connector`, current: 'Missing', expected: 'Configured' }]
          }
        }
        const expected = desiredConnector(target, desired)
        const connector = selectConnector(connectors, target)
        const diff: LogtoConfigurationDiff[] = [...demos]
        if (!connector) {
          diff.push({ field: `${target} connector`, current: 'Missing', expected: expected.id })
        } else {
          addDiff(diff, `${target} connector type`, connector.connectorId, expected.connectorId)
          addDiff(diff, `${target} client ID`, connector.config.clientId ?? null, expected.config.clientId ?? null)
          if (target === 'slack') {
            addDiff(diff, 'Slack OIDC scope', connector.config.scope ?? null, expected.config.scope ?? null)
          }
          if (!connectorMatches(connector, expected) && diff.length === demos.length) {
            diff.push({ field: `${target} OAuth client settings`, current: '*** (different)', expected: '***' })
          }
        }
        return {
          target,
          id: connector?.id ?? null,
          exists: connector !== undefined,
          matches: connector ? connectorMatches(connector, expected) : false,
          diff
        }
      }),
      signInExperienceMatches: this.signInExperienceMatches(signInExperience, desired.socialProviders),
      signInExperienceDiff
    }
  }

  async reconcileSetup(
    desired: LogtoSetupDesired,
    options: LogtoSetupReconcileOptions = {}
  ): Promise<LogtoSetupReconcileResult> {
    const application = await this.ensureApplication(desired)
    const connectors = await this.ensureConnectors(desired, options.refreshConnectorSecrets ?? false)
    const signInExperienceChanged = await this.ensureSignInExperience(desired.socialProviders)
    const adminRoleCreated = (await this.ensureAdminRole()).created
    return {
      changed:
        application.changed ||
        connectors.some((connector) => connector.changed) ||
        signInExperienceChanged ||
        adminRoleCreated,
      application,
      connectors,
      signInExperienceChanged,
      adminRoleCreated
    }
  }

  private async assign(subject: string): Promise<void> {
    const { role } = await this.ensureAdminRole()
    await this.request(`/api/users/${encodeURIComponent(subject)}/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roleIds: [role.id] })
    })
  }

  private async ensureAdminRole(): Promise<{ role: LogtoRole; created: boolean }> {
    const roles = await this.listRoles()
    const existing = roles.find((role) => role.name === ADMIN_ROLE)
    if (existing) {
      if (existing.type !== 'User' || existing.isDefault) {
        throw new LogtoManagementError(
          'ADMIN_ROLE_TYPE_INVALID',
          'the existing Logto ADMIN role must be a non-default User role'
        )
      }
      return { role: existing, created: false }
    }

    const response = await this.request('/api/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: ADMIN_ROLE,
        description: 'AgentConnect deployment administrators',
        type: 'User',
        isDefault: false
      })
    })
    const created = (await response.json().catch(() => null)) as Partial<LogtoRole> | null
    if (
      !created ||
      typeof created.id !== 'string' ||
      created.name !== ADMIN_ROLE ||
      created.type !== 'User' ||
      created.isDefault !== false
    ) {
      throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned an invalid ADMIN role', response.status)
    }
    return { role: created as LogtoRole, created: true }
  }

  private async ensureApplication(
    desired: LogtoSetupDesired
  ): Promise<{ id: string; created: boolean; changed: boolean }> {
    const existing = await this.findApplication(desired.applicationId)
    if (!existing) {
      const response = await this.request('/api/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: desired.applicationName,
          description: 'AgentConnect browser application',
          type: 'SPA',
          oidcClientMetadata: {
            redirectUris: desired.redirectUris,
            postLogoutRedirectUris: desired.postLogoutRedirectUris
          },
          customData: { [MANAGED_APP_TAG]: MANAGED_APP_TAG_VALUE }
        })
      })
      return { id: parseApplication(await response.json().catch(() => null)).id, created: true, changed: true }
    }
    this.requireSpa(existing)
    if (this.applicationMatches(existing, desired)) {
      return { id: existing.id, created: false, changed: false }
    }
    const response = await this.request(`/api/applications/${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        oidcClientMetadata: {
          ...existing.oidcClientMetadata,
          redirectUris: mergeStrings(existing.oidcClientMetadata.redirectUris, desired.redirectUris),
          postLogoutRedirectUris: mergeStrings(
            existing.oidcClientMetadata.postLogoutRedirectUris,
            desired.postLogoutRedirectUris
          )
        },
        customData: { ...existing.customData, [MANAGED_APP_TAG]: MANAGED_APP_TAG_VALUE }
      })
    })
    return { id: parseApplication(await response.json().catch(() => null)).id, created: false, changed: true }
  }

  private async findApplication(applicationId: string | undefined): Promise<LogtoApplication | undefined> {
    if (applicationId) {
      try {
        const application = parseApplication(
          await this.getJson(`/api/applications/${encodeURIComponent(applicationId)}`)
        )
        this.requireSpa(application)
        return application
      } catch (error) {
        if (!(error instanceof LogtoManagementError) || error.status !== 404) throw error
      }
    }
    const tagged = (await this.listApplications()).filter(hasManagedTag)
    if (tagged.length > 1) {
      throw new LogtoManagementError(
        'MANAGED_APPLICATION_AMBIGUOUS',
        'Logto has more than one AgentConnect-managed browser application'
      )
    }
    if (tagged[0]) this.requireSpa(tagged[0])
    return tagged[0]
  }

  private requireSpa(application: LogtoApplication): void {
    if (application.type !== 'SPA') {
      throw new LogtoManagementError(
        'APPLICATION_TYPE_INVALID',
        `the selected Logto application ${application.id} must be a SPA`
      )
    }
  }

  private applicationMatches(application: LogtoApplication, desired: LogtoSetupDesired): boolean {
    return (
      application.type === 'SPA' &&
      (application.id === desired.applicationId || hasManagedTag(application)) &&
      containsStrings(application.oidcClientMetadata.redirectUris, desired.redirectUris) &&
      containsStrings(application.oidcClientMetadata.postLogoutRedirectUris, desired.postLogoutRedirectUris)
    )
  }

  private async listApplications(): Promise<LogtoApplication[]> {
    const result: LogtoApplication[] = []
    for (let page = 1; ; page += 1) {
      const rows = await this.getJson<unknown>(`/api/applications?page=${page}&page_size=100`)
      if (!Array.isArray(rows)) {
        throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned invalid applications')
      }
      result.push(...rows.map(parseApplication))
      if (rows.length < 100) return result
    }
  }

  private async ensureConnectors(
    desired: LogtoSetupDesired,
    refreshSecrets: boolean
  ): Promise<Array<{ target: string; id: string; created: boolean; changed: boolean }>> {
    const existing = await this.listConnectors()
    const result: Array<{ target: string; id: string; created: boolean; changed: boolean }> = []
    for (const target of desired.socialProviders) {
      if (!isManagedConnectorTarget(target)) {
        const connector = selectConnector(existing, target)
        if (!connector) {
          // Never delete a demo connector we cannot replace — name it so the operator can.
          throw new LogtoManagementError(
            'SOCIAL_CONNECTOR_UNSUPPORTED',
            selectDemoConnectors(existing, target).length > 0
              ? `a Logto demo connector occupies the ${target} social target; delete it in Logto, then create the real ${target} connector`
              : `automatic creation is not supported for the missing Logto social connector ${target}`
          )
        }
        result.push({ target, id: connector.id, created: false, changed: false })
        continue
      }
      // Resolve the replacement first: a missing credential must fail before anything is deleted.
      const expected = desiredConnector(target, desired)
      await this.deleteDemoConnectors(existing, target)
      const connector = selectConnector(existing, target)
      if (connector && connectorMatches(connector, expected) && !refreshSecrets) {
        result.push({ target, id: connector.id, created: false, changed: false })
        continue
      }
      if (connector) {
        const response = await this.request(`/api/connectors/${encodeURIComponent(connector.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: expected.config, syncProfile: true })
        })
        const updated = parseConnector(await response.json().catch(() => null))
        if (!updated || updated.target !== target) {
          throw new LogtoManagementError('LOGTO_UNAVAILABLE', `Logto returned an invalid ${target} connector`)
        }
        existing.splice(existing.indexOf(connector), 1, updated)
        result.push({ target, id: updated.id, created: false, changed: true })
        continue
      }
      const response = await this.request('/api/connectors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: expected.id,
          connectorId: expected.connectorId,
          config: expected.config,
          syncProfile: true
        })
      })
      const created = parseConnector(await response.json().catch(() => null))
      if (!created || created.target !== target) {
        throw new LogtoManagementError(
          'LOGTO_UNAVAILABLE',
          `Logto returned an invalid ${target} connector`,
          response.status
        )
      }
      existing.push(created)
      result.push({ target, id: created.id, created: true, changed: true })
    }
    return result
  }

  /**
   * Drop the Logto Cloud demo connectors parked on a managed target. Logto rejects creating the
   * real connector while one holds the same target and platform, and rejects patching the demo one.
   */
  private async deleteDemoConnectors(existing: LogtoConnector[], target: string): Promise<void> {
    for (const demo of selectDemoConnectors(existing, target)) {
      await this.request(`/api/connectors/${encodeURIComponent(demo.id)}`, { method: 'DELETE' })
      existing.splice(existing.indexOf(demo), 1)
    }
  }

  private async listConnectors(): Promise<LogtoConnector[]> {
    const rows = await this.getJson<unknown>('/api/connectors')
    if (!Array.isArray(rows)) throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned invalid connectors')
    return rows.map(parseConnector).filter((connector): connector is LogtoConnector => connector !== null)
  }

  private async getSignInExperience(): Promise<LogtoSignInExperience> {
    const value = asRecord(await this.getJson('/api/sign-in-exp'))
    if (!Array.isArray(value.socialSignInConnectorTargets) || !value.signIn || !value.signUp) {
      throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned an invalid sign-in experience')
    }
    return {
      signIn: asRecord(value.signIn),
      signUp: asRecord(value.signUp),
      socialSignInConnectorTargets: stringArray(value.socialSignInConnectorTargets),
      signInMode: value.signInMode
    }
  }

  private signInExperienceMatches(current: LogtoSignInExperience, targets: readonly string[]): boolean {
    const methods = current.signIn.methods
    const identifiers = current.signUp.identifiers
    const secondaryIdentifiers = current.signUp.secondaryIdentifiers
    return (
      Array.isArray(methods) &&
      methods.length === 0 &&
      Array.isArray(identifiers) &&
      identifiers.length === 0 &&
      current.signUp.password === false &&
      current.signUp.verify === false &&
      (secondaryIdentifiers === undefined ||
        (Array.isArray(secondaryIdentifiers) && secondaryIdentifiers.length === 0)) &&
      current.signInMode === 'SignInAndRegister' &&
      sameStrings(current.socialSignInConnectorTargets, targets)
    )
  }

  private async ensureSignInExperience(targets: readonly string[]): Promise<boolean> {
    const current = await this.getSignInExperience()
    if (this.signInExperienceMatches(current, targets)) return false
    await this.request('/api/sign-in-exp', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signIn: { methods: [] },
        signUp: { identifiers: [], password: false, verify: false, secondaryIdentifiers: [] },
        socialSignInConnectorTargets: targets,
        signInMode: 'SignInAndRegister'
      })
    })
    return true
  }

  private async listRoles(): Promise<LogtoRole[]> {
    const result: LogtoRole[] = []
    for (let page = 1; ; page += 1) {
      const rows = await this.getJson<unknown[]>(`/api/roles?page=${page}&page_size=100`)
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const candidate = row as Partial<LogtoRole>
        if (
          typeof candidate.id === 'string' &&
          typeof candidate.name === 'string' &&
          (candidate.type === 'User' || candidate.type === 'MachineToMachine') &&
          typeof candidate.isDefault === 'boolean'
        ) {
          result.push(candidate as LogtoRole)
        }
      }
      if (rows.length < 100) return result
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path)
    try {
      return (await response.json()) as T
    } catch {
      throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned malformed JSON', response.status)
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${await this.accessToken()}`, ...init.headers },
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      throw new LogtoManagementError(
        'LOGTO_UNAVAILABLE',
        `Logto request failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!response.ok) {
      throw new LogtoManagementError(
        'LOGTO_UNAVAILABLE',
        `Logto request failed: HTTP ${response.status}`,
        response.status
      )
    }
    return response
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return this.token.value
    this.tokenRequest ??= this.fetchAccessToken().finally(() => {
      this.tokenRequest = undefined
    })
    return this.tokenRequest
  }

  private async fetchAccessToken(): Promise<string> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}/oidc/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.appId}:${this.config.appSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          resource: this.resource,
          scope: 'all'
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      throw new LogtoManagementError(
        'LOGTO_UNAVAILABLE',
        `Logto token request failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!response.ok) {
      throw new LogtoManagementError(
        'LOGTO_UNAVAILABLE',
        `Logto token request failed: HTTP ${response.status}`,
        response.status
      )
    }
    const payload = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null
    if (!payload || typeof payload.access_token !== 'string' || typeof payload.expires_in !== 'number') {
      throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned a malformed token response')
    }
    this.token = {
      value: payload.access_token,
      expiresAt: this.now() + Math.max(0, payload.expires_in * 1000 - 60_000)
    }
    return this.token.value
  }
}
