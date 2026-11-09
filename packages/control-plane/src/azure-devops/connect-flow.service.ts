// Connect with Microsoft and Manage project access (azure-devops-integration.md §3.2 steps 1-4), ending in the connection service's steps 5 and 6.
import { randomUUID } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import type { AzureDevOpsConnectionRecord, AzureDevOpsConnectionRepo } from '../persistence/ports.js'
import { AzureDevOpsApiError, readConnectionData, requestAccessToken, type AzureDevOpsApiClient } from './api.js'
import {
  ADD_USERS_REFUSED,
  addGroupMembership,
  allowServiceHookSubscriptions,
  addServicePrincipalEntitlement,
  addServicePrincipalThroughGroup,
  findProjectGroup,
  listMemberOrganizations,
  listProjects,
  raiseServicePrincipalToBasic,
  reachesRepositories,
  grantOrgWideAccess,
  readGraphDescriptor,
  readOrgWideAccess,
  readProjectGroups,
  readResourceTenant,
  readServiceHookGrants,
  readServicePrincipalAccessLevel,
  removeGroupMembership,
  removeOrgWideAccess,
  revokeServiceHookSubscriptions,
  type AzureDevOpsOrgWideAccess,
  type AzureDevOpsMembershipOutcome,
  type AzureDevOpsTriggerGrantOutcome
} from './admin-api.js'
import {
  AzureDevOpsSignInError,
  azureDevOpsAdminConsentUrl,
  azureDevOpsAuthorizeUrl,
  azureDevOpsConnectRedirectUri,
  consentError,
  flowTicketExpiry,
  isConsentError,
  jwtClaims,
  mintAzureDevOpsConnectState,
  openAzureDevOpsFlowTicket,
  redeemAzureDevOpsCode,
  sealAzureDevOpsFlowTicket,
  verifyAzureDevOpsConnectState,
  type AzureDevOpsConnectKeys,
  type AzureDevOpsFlowTicket,
  type AzureDevOpsProjectChoice
} from './connect.js'
import {
  AzureDevOpsConnectDenied,
  type AzureDevOpsConnectionService,
  type AzureDevOpsDeploymentApplication
} from './connection.service.js'

/** How one chosen project's membership went; `not_attempted` while the service principal is not in the organization. */
export interface AzureDevOpsMembershipReport {
  projectId: string
  projectName: string
  group: 'readers' | 'contributors'
  outcome: AzureDevOpsMembershipOutcome | 'group_missing' | 'not_attempted'
}

/** How Allow triggers went on one project (§11.1); `refused` names a role the caller lacks and is in the checklist. */
export interface AzureDevOpsTriggerReport {
  projectId: string
  projectName: string
  outcome: AzureDevOpsTriggerGrantOutcome
}

export interface AzureDevOpsConnectRefusalDetails {
  adminConsentUrl?: string
  checklist?: string[]
  memberships?: AzureDevOpsMembershipReport[]
  /** Whether the service principal is in the organization now. */
  inOrganization?: boolean
  /** A flow that can resume at verification keeps its ticket; a terminal refusal returns none. */
  ticket?: string
  /** A sign-in at the organization's own tenant, for a guest who signed in at their home tenant. */
  authorizeUrl?: string
}

/** A refusal with what the person needs next: an admin-consent link, a manual checklist, or a ticket to resume with. */
export class AzureDevOpsConnectRefusal extends AzureDevOpsConnectDenied {
  constructor(
    message: string,
    status: AzureDevOpsConnectDenied['status'],
    code: string,
    readonly details: AzureDevOpsConnectRefusalDetails
  ) {
    super(message, status, code)
    this.name = 'AzureDevOpsConnectRefusal'
  }
}

export interface AzureDevOpsConnectFlowDeps {
  api: AzureDevOpsApiClient
  keys: AzureDevOpsConnectKeys
  clock: Clock
  connections: AzureDevOpsConnectionService
  connectionRepo: Pick<AzureDevOpsConnectionRepo, 'get' | 'listForOrg' | 'holderOfInstance'>
  /** Absent ⇒ every step refuses: the own-application path is the only one. */
  deploymentApplication?: AzureDevOpsDeploymentApplication
  /** The Console origin whose `/azure-devops/connect` page Microsoft redirects to. */
  webAppUrl?: string
  /** After Allow triggers was granted somewhere: converge the connection's hooked repositories again. */
  onTriggersAllowed?: (orgId: string, connectionId: string) => Promise<void> | void
}

export interface AzureDevOpsFlowStart {
  flowId: string
  ticket: string
  tenantId: string
  connectionId: string | null
  organization: string | null
  expiresAt: number
}

export interface AzureDevOpsFlowResult {
  connection: AzureDevOpsConnectionRecord
  memberships: AzureDevOpsMembershipReport[]
  /** One entry per project with Allow triggers on. */
  triggers: AzureDevOpsTriggerReport[]
  /** What the caller could not do here and someone must do by hand; absent when nothing is left. */
  checklist?: string[]
}

/** Connect-time answers the new and managed flows share; never a token. */
/** A project of the chosen organization, with what the application already holds there. */
export interface AzureDevOpsListedProject {
  id: string
  name: string
  access?: { group: 'readers' | 'contributors'; allowTriggers: boolean }
}

interface ServicePrincipal {
  objectId: string
  displayName: string | null
}

const RESUMABLE = new Set(['no_repository_access', 'access_revoked'])
const SUCCEEDED = new Set<AzureDevOpsMembershipReport['outcome']>(['added', 'already_member'])
const GROUP_NAME = { readers: 'Readers', contributors: 'Contributors' } as const

function same(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

function flowInvalid(): AzureDevOpsConnectDenied {
  return new AzureDevOpsConnectDenied(
    'this Microsoft sign-in has expired — start connecting again',
    400,
    'connect_flow_invalid'
  )
}

/** A delegated Azure DevOps call's failure, as the person who signed in reads it. */
function delegatedDenied(e: unknown, organization?: string): never {
  if (!(e instanceof AzureDevOpsApiError)) throw e
  const where = organization ?? 'that organization'
  switch (e.code) {
    case 'ACCESS_REVOKED':
      throw new AzureDevOpsConnectDenied(
        `your Microsoft account is not a member of ${where}`,
        403,
        'organization_access_denied'
      )
    case 'UNAUTHORIZED':
      throw new AzureDevOpsConnectDenied(
        'Azure DevOps did not accept your sign-in — start connecting again',
        403,
        'sign_in_rejected'
      )
    case 'FORBIDDEN':
      throw new AzureDevOpsConnectDenied(
        `your account may not make this change in ${where}`,
        403,
        'insufficient_rights'
      )
    case 'NOT_FOUND':
      throw new AzureDevOpsConnectDenied(`no Azure DevOps organization named ${where}`, 404, 'organization_not_found')
    case 'RATE_LIMITED':
      throw new AzureDevOpsConnectDenied(`azure devops: ${e.message}`, 429, 'rate_limited')
    case 'INVALID_REQUEST':
      throw new AzureDevOpsConnectDenied(`azure devops: ${e.message}`, 400, 'invalid_request')
    default:
      throw new AzureDevOpsConnectDenied(`azure devops: ${e.message}`, 502, 'azure_devops_unavailable')
  }
}

export class AzureDevOpsConnectFlowService {
  constructor(private readonly deps: AzureDevOpsConnectFlowDeps) {}

  private live(): { app: AzureDevOpsDeploymentApplication; redirectUri: string } {
    const app = this.deps.deploymentApplication
    if (!app) {
      throw new AzureDevOpsConnectDenied(
        'this deployment has no Microsoft application — use your own application instead',
        409,
        'deployment_application_missing'
      )
    }
    if (!this.deps.webAppUrl) {
      throw new AzureDevOpsConnectDenied(
        'this deployment has no Console address for Microsoft to return to',
        409,
        'console_origin_missing'
      )
    }
    return { app, redirectUri: azureDevOpsConnectRedirectUri(this.deps.webAppUrl) }
  }

  /** The connection Manage project access is for; only a `deployment` one. */
  private async managed(orgId: string, connectionId: string): Promise<AzureDevOpsConnectionRecord> {
    const connection = await this.deps.connectionRepo.get(orgId, connectionId)
    if (!connection) {
      throw new AzureDevOpsConnectDenied('azure devops connection not found', 404, 'connection_missing')
    }
    if (connection.credentialSource !== 'deployment') {
      throw new AzureDevOpsConnectDenied(
        'this connection uses your own application — manage its project access in Azure DevOps',
        409,
        'connection_not_deployment'
      )
    }
    return connection
  }

  /** One Azure DevOps connection per organization in the first version (§3.2). */
  private async refuseSecondConnection(orgId: string): Promise<void> {
    if ((await this.deps.connectionRepo.listForOrg(orgId)).length > 0) {
      throw new AzureDevOpsConnectDenied(
        'this organization already has an Azure DevOps connection — use Manage project access, or disconnect it first',
        409,
        'connection_exists'
      )
    }
  }

  /** Step 1: a signed state and Microsoft's authorize URL; a connection id starts Manage project access at its tenant. */
  async start(orgId: string, userId: string, connectionId?: string): Promise<{ authorizeUrl: string }> {
    const { app, redirectUri } = this.live()
    let tenantId: string | undefined
    if (connectionId !== undefined) tenantId = (await this.managed(orgId, connectionId)).tenantId
    else await this.refuseSecondConnection(orgId)
    const state = mintAzureDevOpsConnectState(
      this.deps.keys,
      { orgId, userId, ...(connectionId ? { connectionId } : {}), ...(tenantId ? { tenantId } : {}) },
      this.deps.clock
    )
    return {
      authorizeUrl: azureDevOpsAuthorizeUrl(this.deps.api, this.deps.keys, {
        clientId: app.clientId,
        redirectUri,
        state,
        ...(tenantId ? { tenantId } : {})
      })
    }
  }

  private signInDenied(e: AzureDevOpsSignInError, clientId: string, tenantId?: string): AzureDevOpsConnectDenied {
    switch (e.code) {
      case 'consent_required':
        return new AzureDevOpsConnectRefusal(e.message, 403, 'consent_required', {
          ...(tenantId ? { adminConsentUrl: azureDevOpsAdminConsentUrl(this.deps.api, tenantId, clientId) } : {})
        })
      case 'unavailable':
        return new AzureDevOpsConnectDenied(e.message, 502, 'azure_devops_unavailable')
      default:
        return new AzureDevOpsConnectDenied(e.message, 400, e.code)
    }
  }

  /** Step 2: verify the state, redeem the code, and seal the delegated token into a flow ticket. */
  async callback(
    orgId: string,
    userId: string,
    input: { state: string; code?: string; error?: string; errorDescription?: string }
  ): Promise<AzureDevOpsFlowStart> {
    const { app, redirectUri } = this.live()
    const state = verifyAzureDevOpsConnectState(this.deps.keys, input.state, this.deps.clock)
    if (!state || state.orgId !== orgId || state.userId !== userId) {
      throw new AzureDevOpsConnectDenied(
        'this Microsoft sign-in has expired — start connecting again',
        400,
        'connect_state_invalid'
      )
    }
    if (input.error !== undefined || !input.code) {
      const error = isConsentError(input.error, input.errorDescription)
        ? consentError()
        : new AzureDevOpsSignInError(
            'sign_in_refused',
            'Microsoft did not complete the sign-in. Start connecting again.'
          )
      throw this.signInDenied(error, app.clientId, state.tenantId)
    }
    const managed = state.connectionId ? await this.managed(orgId, state.connectionId) : undefined
    if (!managed) await this.refuseSecondConnection(orgId)
    let redeemed: Awaited<ReturnType<typeof redeemAzureDevOpsCode>>
    try {
      redeemed = await redeemAzureDevOpsCode(this.deps.api, this.deps.keys, {
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        redirectUri,
        code: input.code,
        state: input.state,
        ...(state.tenantId ? { tenantId: state.tenantId } : {})
      })
    } catch (e) {
      if (e instanceof AzureDevOpsSignInError) throw this.signInDenied(e, app.clientId, state.tenantId)
      throw e
    }
    const ticket: AzureDevOpsFlowTicket = {
      flowId: randomUUID(),
      orgId,
      userId,
      tenantId: redeemed.tenantId,
      accessToken: redeemed.accessToken,
      ...(managed
        ? {
            connectionId: managed.id,
            organization: managed.organization,
            organizationInstanceId: managed.organizationInstanceId
          }
        : {}),
      expiresAt: flowTicketExpiry(this.deps.clock, redeemed.expiresInSec)
    }
    return {
      flowId: ticket.flowId,
      ticket: sealAzureDevOpsFlowTicket(this.deps.keys, ticket),
      tenantId: ticket.tenantId,
      connectionId: managed?.id ?? null,
      organization: managed?.organization ?? null,
      expiresAt: ticket.expiresAt
    }
  }

  /** The ticket of this flow, for this organization and caller; anything else reads as expired. */
  open(orgId: string, userId: string, flowId: string, raw: string | undefined): AzureDevOpsFlowTicket {
    this.live()
    const ticket = raw ? openAzureDevOpsFlowTicket(this.deps.keys, raw, this.deps.clock) : null
    if (!ticket || ticket.orgId !== orgId || ticket.userId !== userId || ticket.flowId !== flowId) throw flowInvalid()
    return ticket
  }

  /** Step 3: the organizations the administrator belongs to. */
  async organizations(ticket: AzureDevOpsFlowTicket): Promise<Array<{ id: string; name: string }>> {
    try {
      return await listMemberOrganizations(this.deps.api, ticket.accessToken)
    } catch (e) {
      return delegatedDenied(e)
    }
  }

  /** Step 3's choice: the administrator reaches the organization, no other AgentConnect organization holds it, and its projects. */
  async chooseOrganization(
    ticket: AzureDevOpsFlowTicket,
    organization: string
  ): Promise<{
    ticket: string
    organization: string
    projects: AzureDevOpsListedProject[]
    allProjects?: AzureDevOpsOrgWideAccess
  }> {
    if (ticket.connectionId && !same(ticket.organization, organization)) {
      throw new AzureDevOpsConnectDenied(
        `Manage project access is for ${ticket.organization}`,
        409,
        'organization_fixed'
      )
    }
    const chosen = ticket.connectionId ? ticket.organization! : organization
    if (!ticket.connectionId) await this.refuseOtherTenant(ticket, chosen)
    let instanceId: string
    let projects: Array<{ id: string; name: string }>
    try {
      instanceId = (await readConnectionData(this.deps.api, ticket.accessToken, chosen)).instanceId
      projects = await listProjects(this.deps.api, ticket.accessToken, chosen)
    } catch (e) {
      return delegatedDenied(e, chosen)
    }
    if (ticket.connectionId) {
      if (!same(instanceId, ticket.organizationInstanceId)) {
        throw new AzureDevOpsConnectDenied(
          `${chosen} is no longer the organization this connection was made for — disconnect and connect again`,
          409,
          'organization_mismatch'
        )
      }
    } else {
      await this.refuseTaken(ticket.orgId, instanceId)
    }
    const next: AzureDevOpsFlowTicket = { ...ticket, organization: chosen, organizationInstanceId: instanceId }
    delete next.projects
    delete next.shownAccess
    delete next.allProjects
    delete next.shownAllProjects
    // The page opens on what the application already holds; the ticket keeps it, the only access Apply may take away.
    const current = await this.currentAccess(next, chosen)
    const listed = projects.map((project): AzureDevOpsListedProject => {
      const groups = current?.groups.get(project.id.toLowerCase())
      const group = groups?.has('contributors') ? 'contributors' : groups?.has('readers') ? 'readers' : null
      return group
        ? { ...project, access: { group, allowTriggers: current!.triggers.has(project.id.toLowerCase()) } }
        : project
    })
    if (current) {
      next.shownAccess = Object.fromEntries(
        listed.flatMap((project) => (project.access ? [[project.id.toLowerCase(), project.access]] : []))
      )
      if (current.orgWide) next.shownAllProjects = current.orgWide
    }
    return {
      ticket: sealAzureDevOpsFlowTicket(this.deps.keys, next),
      organization: chosen,
      projects: listed,
      ...(current?.orgWide ? { allProjects: current.orgWide } : {})
    }
  }

  /** The application's project groups and Allow triggers grants, as the administrator sees them; null when unreadable or not in the organization. */
  private async currentAccess(
    ticket: AzureDevOpsFlowTicket,
    organization: string,
    known?: { sp: ServicePrincipal; subject: string }
  ): Promise<{
    sp: ServicePrincipal
    subject: string
    groups: Map<string, Map<'readers' | 'contributors', string>>
    triggers: Set<string>
    orgWide: AzureDevOpsOrgWideAccess | null
  } | null> {
    try {
      let found = known
      if (!found) {
        const { sp, appToken } = await this.servicePrincipal(ticket)
        const identityId = await this.memberIdentity(appToken, organization)
        if (identityId === null) return null
        found = { sp, subject: await readGraphDescriptor(this.deps.api, ticket.accessToken, organization, identityId) }
      }
      const groups = await readProjectGroups(this.deps.api, ticket.accessToken, organization, found.subject)
      const principal = { tenantId: ticket.tenantId, servicePrincipalObjectId: found.sp.objectId }
      const triggers = await readServiceHookGrants(this.deps.api, ticket.accessToken, organization, principal)
      // Reading the roots may need more than a Project Administrator has; the projects still show.
      const orgWide = await readOrgWideAccess(this.deps.api, ticket.accessToken, organization, principal).catch(
        () => null
      )
      return { ...found, groups, triggers, orgWide }
    } catch {
      return null
    }
  }

  /** Take away what the page showed and no longer asks for: a group left or changed, and Allow triggers turned off; what is refused joins the checklist. */
  private async removeUndesired(
    ticket: AzureDevOpsFlowTicket,
    organization: string,
    sp: ServicePrincipal,
    subject: string
  ): Promise<{ checklist: string[]; revoked: boolean }> {
    const orgWide = await this.removeOrgWide(ticket, organization, sp)
    const shown = ticket.shownAccess
    if (!shown) return orgWide
    const current = await this.currentAccess(ticket, organization, { sp, subject })
    if (!current) return orgWide
    const desired = new Map((ticket.projects ?? []).map((choice) => [choice.projectId.toLowerCase(), choice]))
    const names = new Map<string, string>()
    try {
      for (const project of await listProjects(this.deps.api, ticket.accessToken, organization))
        names.set(project.id.toLowerCase(), project.name)
    } catch {
      // Names only label the checklist.
    }
    const checklist: string[] = []
    let revoked = false
    for (const [projectId, groups] of current.groups) {
      const want = desired.get(projectId)
      for (const [group, descriptor] of groups) {
        // Only the group the page showed; one granted since, or never displayed, stays.
        if (shown[projectId]?.group !== group || want?.group === group) continue
        const outcome = await removeGroupMembership(
          this.deps.api,
          ticket.accessToken,
          organization,
          subject,
          descriptor
        )
        if (outcome !== 'removed')
          checklist.push(`Remove it from the ${GROUP_NAME[group]} group of ${names.get(projectId) ?? projectId}.`)
      }
    }
    for (const projectId of current.triggers) {
      if (!shown[projectId]?.allowTriggers || desired.get(projectId)?.allowTriggers) continue
      const outcome = await revokeServiceHookSubscriptions(this.deps.api, ticket.accessToken, organization, {
        projectId,
        tenantId: ticket.tenantId,
        servicePrincipalObjectId: sp.objectId
      })
      if (outcome === 'removed') revoked = true
      else checklist.push(`Turn off Allow triggers on ${names.get(projectId) ?? projectId}.`)
    }
    return { checklist: [...orgWide.checklist, ...checklist], revoked: revoked || orgWide.revoked }
  }

  /** All projects as the page showed it: the entries go by the ticket, not a fresh read, so a removal cut short finishes on retry. */
  private async removeOrgWide(
    ticket: AzureDevOpsFlowTicket,
    organization: string,
    sp: ServicePrincipal
  ): Promise<{ checklist: string[]; revoked: boolean }> {
    const shownAll = ticket.shownAllProjects
    if (!shownAll) return { checklist: [], revoked: false }
    const access = !ticket.allProjects
    const triggers = shownAll.allowTriggers && !ticket.allProjects?.allowTriggers
    if (!access && !triggers) return { checklist: [], revoked: false }
    const outcome = await removeOrgWideAccess(this.deps.api, ticket.accessToken, organization, {
      tenantId: ticket.tenantId,
      servicePrincipalObjectId: sp.objectId,
      access,
      triggers
    })
    if (outcome === 'removed') return { checklist: [], revoked: triggers }
    return {
      checklist: [access ? 'Remove its access to all projects.' : 'Turn off Allow triggers for all projects.'],
      revoked: false
    }
  }

  /** A guest signs in at their home tenant; the organization's own tenant, from an unauthenticated read, must be the one signed in at. */
  private async refuseOtherTenant(ticket: AzureDevOpsFlowTicket, organization: string): Promise<void> {
    const resourceTenant = await readResourceTenant(this.deps.api, organization)
    if (resourceTenant === null || resourceTenant === ticket.tenantId) return
    const { app, redirectUri } = this.live()
    const state = mintAzureDevOpsConnectState(
      this.deps.keys,
      { orgId: ticket.orgId, userId: ticket.userId, tenantId: resourceTenant },
      this.deps.clock
    )
    throw new AzureDevOpsConnectRefusal(
      `${organization} belongs to another Microsoft Entra tenant than the one you signed in at — sign in again at that tenant, as its member or guest.`,
      409,
      'tenant_mismatch',
      {
        authorizeUrl: azureDevOpsAuthorizeUrl(this.deps.api, this.deps.keys, {
          clientId: app.clientId,
          redirectUri,
          state,
          tenantId: resourceTenant
        })
      }
    )
  }

  private async refuseTaken(orgId: string, instanceId: string): Promise<void> {
    const holder = await this.deps.connectionRepo.holderOfInstance(instanceId)
    if (holder !== null && holder !== orgId) {
      throw new AzureDevOpsConnectDenied(
        'this Azure DevOps organization is already connected to another organization on this deployment',
        409,
        'AZURE_DEVOPS_ORGANIZATION_TAKEN'
      )
    }
  }

  /** Before any write in Azure DevOps: a new flow still has no connection here, a managed one still has its own. */
  private async guard(ticket: AzureDevOpsFlowTicket): Promise<string> {
    if (!ticket.organization || !ticket.organizationInstanceId) {
      throw new AzureDevOpsConnectDenied('choose an Azure DevOps organization first', 409, 'organization_required')
    }
    if (ticket.connectionId) await this.managed(ticket.orgId, ticket.connectionId)
    else {
      await this.refuseSecondConnection(ticket.orgId)
      await this.refuseTaken(ticket.orgId, ticket.organizationInstanceId)
    }
    return ticket.organization
  }

  /** The application's service principal in the customer tenant: its object id from an app-only token, which works before it joins the organization. */
  private async servicePrincipal(ticket: AzureDevOpsFlowTicket): Promise<{ sp: ServicePrincipal; appToken: string }> {
    const { app } = this.live()
    try {
      const { accessToken } = await requestAccessToken(this.deps.api, {
        tenantId: ticket.tenantId,
        clientId: app.clientId,
        clientSecret: app.clientSecret
      })
      const claims = jwtClaims(accessToken)
      const oid = typeof claims?.oid === 'string' ? claims.oid.toLowerCase() : ''
      if (!oid) throw new AzureDevOpsApiError('Microsoft issued a token without an object id', 200, 'UNAVAILABLE', true)
      const name = typeof claims?.app_displayname === 'string' ? claims.app_displayname : null
      return { sp: { objectId: oid, displayName: name }, appToken: accessToken }
    } catch (e) {
      if (e instanceof AzureDevOpsApiError && e.code === 'ACCESS_REVOKED') {
        throw new AzureDevOpsConnectRefusal(consentError().message, 403, 'consent_required', {
          adminConsentUrl: azureDevOpsAdminConsentUrl(this.deps.api, ticket.tenantId, app.clientId)
        })
      }
      if (e instanceof AzureDevOpsApiError && e.code === 'SECRET_REJECTED') {
        throw new AzureDevOpsConnectDenied(
          'Microsoft rejected the deployment’s application secret — ask the deployment’s operator to rotate it in Setup',
          502,
          'deployment_secret_rejected'
        )
      }
      return delegatedDenied(e)
    }
  }

  /** `connectionData` as the application: 200 is a member (with its identity id), TF401444 or TF400813 is not. */
  private async memberIdentity(appToken: string, organization: string): Promise<string | null> {
    try {
      return (await readConnectionData(this.deps.api, appToken, organization)).identityId
    } catch (e) {
      if (e instanceof AzureDevOpsApiError && e.code === 'ACCESS_REVOKED') return null
      return delegatedDenied(e, organization)
    }
  }

  private async subjectOf(ticket: AzureDevOpsFlowTicket, organization: string, identityId: string): Promise<string> {
    try {
      return await readGraphDescriptor(this.deps.api, ticket.accessToken, organization, identityId)
    } catch (e) {
      return delegatedDenied(e, organization)
    }
  }

  /** One membership per chosen project; with no subject yet, the first one that may also adds the service principal through its group. */
  private async applyMemberships(
    ticket: AzureDevOpsFlowTicket,
    organization: string,
    choices: readonly AzureDevOpsProjectChoice[],
    subject: string | null,
    addThroughGroup?: string
  ): Promise<{ memberships: AzureDevOpsMembershipReport[]; subject: string | null }> {
    const memberships: AzureDevOpsMembershipReport[] = []
    for (const choice of choices) {
      const report = (outcome: AzureDevOpsMembershipReport['outcome']) => memberships.push({ ...choice, outcome })
      if (!subject && !addThroughGroup) {
        report('not_attempted')
        continue
      }
      let group: string | null
      try {
        group = await findProjectGroup(this.deps.api, ticket.accessToken, organization, choice.projectId, choice.group)
      } catch (e) {
        if (e instanceof AzureDevOpsApiError && e.code === 'RATE_LIMITED') return delegatedDenied(e, organization)
        report(e instanceof AzureDevOpsApiError && e.code === 'FORBIDDEN' ? 'refused' : 'failed')
        continue
      }
      if (!group) {
        report('group_missing')
        continue
      }
      try {
        if (!subject) {
          subject = await addServicePrincipalThroughGroup(
            this.deps.api,
            ticket.accessToken,
            organization,
            addThroughGroup!,
            group
          )
          report(subject ? 'added' : 'refused')
          continue
        }
        report(await addGroupMembership(this.deps.api, ticket.accessToken, organization, subject, group))
      } catch (e) {
        return delegatedDenied(e, organization)
      }
    }
    return { memberships, subject }
  }

  private checklist(
    organization: string,
    sp: ServicePrincipal,
    memberships: readonly AzureDevOpsMembershipReport[],
    inOrganization: boolean,
    basicConfirmed = false
  ): string[] {
    const { app } = this.live()
    const named = sp.displayName ? ` (${sp.displayName})` : ''
    const items: string[] = []
    if (!inOrganization) {
      items.push(
        `Add the application to ${organization} as a service principal in Organization settings → Users: search by its client ID ${app.clientId}${named}. Your tenant keeps the name the application had when it was first consented to, so the picker may show an older name.`
      )
    }
    if (!basicConfirmed)
      items.push('Give the service principal the Basic access level; Stakeholder reaches no repository.')
    for (const membership of memberships) {
      if (SUCCEEDED.has(membership.outcome)) continue
      items.push(`Add it to the ${GROUP_NAME[membership.group]} group of ${membership.projectName}.`)
    }
    return items
  }

  /** Step 4: the entitlement and the memberships, then steps 5 and 6. */
  async applyProjects(
    ticket: AzureDevOpsFlowTicket,
    requested: ReadonlyArray<{ projectId: string; group: 'readers' | 'contributors'; allowTriggers?: boolean }>,
    allProjects?: AzureDevOpsOrgWideAccess
  ): Promise<AzureDevOpsFlowResult> {
    const organization = await this.guard(ticket)
    let projects: Array<{ id: string; name: string }>
    try {
      projects = await listProjects(this.deps.api, ticket.accessToken, organization)
    } catch (e) {
      return delegatedDenied(e, organization)
    }
    const byId = new Map(projects.map((project) => [project.id, project]))
    const choices = new Map<string, AzureDevOpsProjectChoice>()
    for (const { projectId, group, allowTriggers } of requested) {
      const project = byId.get(projectId.toLowerCase())
      if (!project) {
        throw new AzureDevOpsConnectDenied(`no project ${projectId} in ${organization}`, 400, 'project_not_found')
      }
      // Contributors already reads; one group per project. Allow triggers defaults on with Contributors (§11.1).
      choices.set(project.id, {
        projectId: project.id,
        projectName: project.name,
        group,
        allowTriggers: allowTriggers ?? group === 'contributors'
      })
    }
    const recorded: AzureDevOpsFlowTicket = { ...ticket, projects: [...choices.values()] }
    if (allProjects) recorded.allProjects = allProjects
    else delete recorded.allProjects
    const resume = sealAzureDevOpsFlowTicket(this.deps.keys, recorded)
    const { sp, appToken } = await this.servicePrincipal(recorded)
    const identityId = await this.memberIdentity(appToken, organization)

    if (identityId !== null) {
      // Already in the organization: no add, but a level below Basic is raised (§3.2 step 4).
      const level = await this.ensureBasic(recorded, organization, identityId)
      const subject = await this.subjectOf(recorded, organization, identityId)
      const { memberships } = await this.applyMemberships(recorded, organization, recorded.projects!, subject)
      const orgWide = await this.applyOrgWide(recorded, organization, sp)
      this.requireAuthority(recorded, organization, sp, memberships, orgWide === 'granted')
      if (level.outcome === 'refused') {
        throw this.entitlementRefusal(organization, sp, level.errorCodes, memberships, true, resume)
      }
      if (memberships.some((m) => !SUCCEEDED.has(m.outcome)))
        throw this.incomplete(organization, sp, memberships, resume, level.outcome === 'basic')
      return this.finish(
        recorded,
        sp,
        memberships,
        resume,
        this.withOrgWide(await this.removeUndesired(recorded, organization, sp, subject), recorded, orgWide)
      )
    }

    let entitlement: Awaited<ReturnType<typeof addServicePrincipalEntitlement>>
    try {
      entitlement = await addServicePrincipalEntitlement(this.deps.api, recorded.accessToken, organization, sp.objectId)
    } catch (e) {
      if (!(e instanceof AzureDevOpsApiError) || e.code !== 'FORBIDDEN') return delegatedDenied(e, organization)
      entitlement = { outcome: 'refused', errorCodes: [], subjectDescriptor: null }
    }
    if (entitlement.outcome === 'added') {
      let subject = entitlement.subjectDescriptor
      if (!subject) {
        const added = await this.memberIdentity(appToken, organization)
        if (added === null) {
          throw new AzureDevOpsConnectDenied(
            `Azure DevOps reported the application added to ${organization} but does not admit it yet — try again shortly`,
            502,
            'azure_devops_unavailable'
          )
        }
        subject = await this.subjectOf(recorded, organization, added)
      }
      const { memberships } = await this.applyMemberships(recorded, organization, recorded.projects!, subject)
      if (memberships.some((m) => !SUCCEEDED.has(m.outcome)))
        throw this.incomplete(organization, sp, memberships, resume, true)
      const orgWide = await this.applyOrgWide(recorded, organization, sp)
      return this.finish(recorded, sp, memberships, resume, this.withOrgWide(undefined, recorded, orgWide))
    }

    // Refused: a Project Administrator may still make the memberships, which also bring the service principal in at the default level.
    const { memberships, subject } = await this.applyMemberships(
      recorded,
      organization,
      recorded.projects!,
      entitlement.subjectDescriptor,
      sp.objectId
    )
    throw this.entitlementRefusal(organization, sp, entitlement.errorCodes, memberships, subject !== null, resume)
  }

  /** A member's level as the delegated caller sees it, raised to Basic when below; `unknown` when the caller may not read it. */
  private async ensureBasic(
    ticket: AzureDevOpsFlowTicket,
    organization: string,
    identityId: string
  ): Promise<{ outcome: 'basic' | 'unknown' } | { outcome: 'refused'; errorCodes: number[] }> {
    let level: string | null
    try {
      level = await readServicePrincipalAccessLevel(this.deps.api, ticket.accessToken, organization, identityId)
    } catch (e) {
      if (e instanceof AzureDevOpsApiError && e.code === 'FORBIDDEN') return { outcome: 'unknown' }
      return delegatedDenied(e, organization)
    }
    if (reachesRepositories(level)) return { outcome: 'basic' }
    try {
      const raised = await raiseServicePrincipalToBasic(this.deps.api, ticket.accessToken, organization, identityId)
      return raised.outcome === 'raised' ? { outcome: 'basic' } : raised
    } catch (e) {
      if (e instanceof AzureDevOpsApiError && e.code === 'FORBIDDEN') return { outcome: 'refused', errorCodes: [] }
      return delegatedDenied(e, organization)
    }
  }

  /** A new connection to a service principal already in the organization needs proof the caller administers it there: at least one membership made or confirmed with their token. */
  private requireAuthority(
    ticket: AzureDevOpsFlowTicket,
    organization: string,
    sp: ServicePrincipal,
    memberships: AzureDevOpsMembershipReport[],
    orgWideGranted = false
  ): void {
    if (ticket.connectionId || orgWideGranted || memberships.some((m) => SUCCEEDED.has(m.outcome))) return
    throw new AzureDevOpsConnectRefusal(
      `Your account could not make or confirm any of the chosen project memberships in ${organization}. Connecting needs a Project Administrator of those projects or a Project Collection Administrator.`,
      403,
      'insufficient_rights',
      {
        checklist: [
          'Ask a Project Administrator of the chosen projects, or a Project Collection Administrator, to connect.',
          ...this.checklist(organization, sp, memberships, true, true)
        ],
        memberships,
        inOrganization: true
      }
    )
  }

  /** The entitlement add or raise refused: 5032 names the role; either way the checklist and a ticket for verify. */
  private entitlementRefusal(
    organization: string,
    sp: ServicePrincipal,
    errorCodes: readonly number[],
    memberships: AzureDevOpsMembershipReport[],
    inOrganization: boolean,
    ticket: string
  ): AzureDevOpsConnectRefusal {
    const made = memberships.filter((m) => SUCCEEDED.has(m.outcome)).length
    const pca = errorCodes.includes(ADD_USERS_REFUSED)
    const codes = errorCodes.length ? ` (error ${errorCodes.join(', ')})` : ''
    const message = pca
      ? `Only a Project Collection Administrator of ${organization} can give the application the Basic access level. ${made} of ${memberships.length} project memberships were made; ask a Project Collection Administrator to finish the checklist, then verify.`
      : `Azure DevOps refused to give the application the Basic access level in ${organization}${codes}. ${made} of ${memberships.length} project memberships were made; finish the checklist, then verify.`
    return new AzureDevOpsConnectRefusal(
      message,
      403,
      pca ? 'project_collection_administrator_required' : 'entitlement_refused',
      { checklist: this.checklist(organization, sp, memberships, inOrganization), memberships, inOrganization, ticket }
    )
  }

  private incomplete(
    organization: string,
    sp: ServicePrincipal,
    memberships: AzureDevOpsMembershipReport[],
    ticket: string,
    basicConfirmed: boolean
  ): AzureDevOpsConnectRefusal {
    return new AzureDevOpsConnectRefusal(
      `Some project memberships in ${organization} could not be made with your account; finish the checklist, then verify.`,
      403,
      'memberships_incomplete',
      {
        checklist: this.checklist(organization, sp, memberships, true, basicConfirmed),
        memberships,
        inOrganization: true,
        ticket
      }
    )
  }

  /** §11.1 Allow triggers on each chosen project, with the delegated token; a refusal is reported, never fatal to the step. */
  private async allowTriggers(
    ticket: AzureDevOpsFlowTicket,
    sp: ServicePrincipal
  ): Promise<AzureDevOpsTriggerReport[]> {
    const reports: AzureDevOpsTriggerReport[] = []
    for (const choice of ticket.projects ?? []) {
      if (!choice.allowTriggers) continue
      let outcome: AzureDevOpsTriggerGrantOutcome
      try {
        outcome = await allowServiceHookSubscriptions(this.deps.api, ticket.accessToken, ticket.organization!, {
          projectId: choice.projectId,
          tenantId: ticket.tenantId,
          servicePrincipalObjectId: sp.objectId
        })
      } catch {
        // Throttled: the rest of the step stands, and the checklist says what is left.
        outcome = 'failed'
      }
      reports.push({ projectId: choice.projectId, projectName: choice.projectName, outcome })
    }
    return reports
  }

  /** What is left for Allow triggers: the role that can grant it, and where to grant it by hand. */
  private triggerChecklist(
    organization: string,
    sp: ServicePrincipal,
    refused: readonly AzureDevOpsTriggerReport[]
  ): string[] {
    const { app } = this.live()
    const named = sp.displayName ? ` (${sp.displayName})` : ''
    return refused.map(
      (report) =>
        `Allow triggers on ${report.projectName}: in ${organization}, Project settings → Service hooks → Security, allow the application's service principal (client ID ${app.clientId}${named}) View subscriptions and Edit subscriptions, or ask a Project Collection Administrator to run Manage project access with Allow triggers on.`
    )
  }

  /** Resume after a manual step: re-check membership, make the memberships the caller may, then steps 5 and 6. */
  async verify(ticket: AzureDevOpsFlowTicket): Promise<AzureDevOpsFlowResult> {
    const organization = await this.guard(ticket)
    if (!ticket.projects?.length && !ticket.allProjects) {
      throw new AzureDevOpsConnectDenied('choose the projects first', 409, 'projects_required')
    }
    const resume = sealAzureDevOpsFlowTicket(this.deps.keys, ticket)
    const { sp, appToken } = await this.servicePrincipal(ticket)
    const identityId = await this.memberIdentity(appToken, organization)
    if (identityId === null) {
      const memberships = (ticket.projects ?? []).map((choice) => ({ ...choice, outcome: 'not_attempted' as const }))
      throw new AzureDevOpsConnectRefusal(
        `The application's service principal is not in ${organization} yet; finish the checklist, then verify.`,
        409,
        'not_in_organization',
        {
          checklist: this.checklist(organization, sp, memberships, false),
          memberships,
          inOrganization: false,
          ticket: resume
        }
      )
    }
    const level = await this.ensureBasic(ticket, organization, identityId)
    const subject = await this.subjectOf(ticket, organization, identityId)
    // A membership the caller may not make may already exist by hand; steps 5 and 6 decide.
    const { memberships } = await this.applyMemberships(ticket, organization, ticket.projects ?? [], subject)
    const orgWide = await this.applyOrgWide(ticket, organization, sp)
    this.requireAuthority(ticket, organization, sp, memberships, orgWide === 'granted')
    if (level.outcome === 'refused') {
      throw this.entitlementRefusal(organization, sp, level.errorCodes, memberships, true, resume)
    }
    return this.finish(
      ticket,
      sp,
      memberships,
      resume,
      this.withOrgWide(await this.removeUndesired(ticket, organization, sp, subject), ticket, orgWide)
    )
  }

  /** All projects, when Apply asked for it: the three root grants; null when it did not. */
  private async applyOrgWide(
    ticket: AzureDevOpsFlowTicket,
    organization: string,
    sp: ServicePrincipal
  ): Promise<AzureDevOpsTriggerGrantOutcome | null> {
    if (!ticket.allProjects) return null
    return grantOrgWideAccess(this.deps.api, ticket.accessToken, organization, {
      tenantId: ticket.tenantId,
      servicePrincipalObjectId: sp.objectId,
      ...ticket.allProjects
    })
  }

  /** Folds the All projects grant into what finish reports: a refusal joins the checklist, granted triggers reconverge. */
  private withOrgWide(
    removal: { checklist: string[]; revoked: boolean } | undefined,
    ticket: AzureDevOpsFlowTicket,
    orgWide: AzureDevOpsTriggerGrantOutcome | null
  ): { checklist: string[]; revoked: boolean } {
    const base = removal ?? { checklist: [], revoked: false }
    if (orgWide === null) return base
    if (orgWide !== 'granted')
      return {
        ...base,
        checklist: [...base.checklist, 'Access to all projects needs a Project Collection Administrator.']
      }
    return { ...base, revoked: base.revoked || ticket.allProjects!.allowTriggers }
  }

  /** Steps 5 and 6: a new connection, or for Manage project access the existing one re-verified; a refusal it can recover from keeps the ticket. */
  private async finish(
    ticket: AzureDevOpsFlowTicket,
    sp: ServicePrincipal,
    memberships: AzureDevOpsMembershipReport[],
    resume: string,
    removal: { checklist: string[]; revoked: boolean } = { checklist: [], revoked: false }
  ): Promise<AzureDevOpsFlowResult> {
    try {
      const connection = ticket.connectionId
        ? await this.deps.connections.reverifyDeploymentConnection(ticket.orgId, ticket.connectionId)
        : await this.deps.connections.connectDeploymentApplication(
            ticket.orgId,
            { organization: ticket.organization!, tenantId: ticket.tenantId },
            ticket.userId
          )
      const triggers = await this.allowTriggers(ticket, sp)
      const refused = triggers.filter((report) => report.outcome !== 'granted')
      if (removal.revoked || triggers.some((report) => report.outcome === 'granted')) {
        try {
          await this.deps.onTriggersAllowed?.(ticket.orgId, connection.id)
        } catch {
          // Convergence is retried by its own sweep; the connection already stands.
        }
      }
      return {
        connection,
        memberships,
        triggers,
        ...(refused.length > 0 || removal.checklist.length > 0
          ? { checklist: [...removal.checklist, ...this.triggerChecklist(ticket.organization!, sp, refused)] }
          : {})
      }
    } catch (e) {
      if (e instanceof AzureDevOpsConnectDenied && RESUMABLE.has(e.code)) {
        throw new AzureDevOpsConnectRefusal(e.message, e.status, e.code, {
          memberships,
          inOrganization: true,
          ticket: resume
        })
      }
      throw e
    }
  }
}
