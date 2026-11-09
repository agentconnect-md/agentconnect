// The Azure DevOps calls service hooks need (azure-devops-integration.md §11.1, §11.2, §11.4): the identity's own grant, subscriptions, and the reads of the membership gate; never log a key or a body.
import { AZURE_DEVOPS_HOOK_BASIC_USER, type AzureDevOpsDeliveryKind } from '@agentconnect.md/protocol'
import {
  AzureDevOpsApiError,
  GIT_REPOSITORIES_NAMESPACE,
  azureDevOpsCall,
  isGuid,
  type AzureDevOpsApiClient
} from './api.js'

/** The ServiceHooks security namespace and its two bits (§11.1); `EditSubscriptions` also deletes. */
export const SERVICE_HOOKS_NAMESPACE = 'cb594ebe-87dd-4fc9-ac2c-6a10a4c92046'
export const VIEW_SUBSCRIPTIONS = 1
export const EDIT_SUBSCRIPTIONS = 2
/** Git Repositories' GenericContribute, the bit the membership gate admits on (§11.4). */
export const GENERIC_CONTRIBUTE_BIT = 4
/** The identities API's host; the organization rides the path. */
export const IDENTITIES_BASE = 'https://vssps.dev.azure.com'

const API_VERSION = '7.1'

/** The ServiceHooks token a project's subscriptions are secured under. */
export function serviceHooksToken(projectId: string): string {
  return `PublisherSecurity/${projectId.toLowerCase()}`
}

/** The service principal's own View and Edit subscriptions on a project, in one permission evaluation (§11.1). */
export async function evaluateServiceHookGrant(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string,
  projectId: string
): Promise<boolean> {
  const securityToken = serviceHooksToken(projectId)
  const json = await azureDevOpsCall<{ evaluations?: Array<{ permissions?: unknown; value?: unknown }> }>(
    client,
    token,
    organization,
    `${client.devOpsBaseUrl}/${encodeURIComponent(organization)}/_apis/security/permissionevaluationbatch?api-version=${API_VERSION}`,
    {
      method: 'POST',
      body: {
        alwaysAllowAdministrators: false,
        evaluations: [VIEW_SUBSCRIPTIONS, EDIT_SUBSCRIPTIONS].map((permissions) => ({
          securityNamespaceId: SERVICE_HOOKS_NAMESPACE,
          token: securityToken,
          permissions
        }))
      }
    }
  )
  const allowed = (bit: number) =>
    (json?.evaluations ?? []).some((evaluation) => Number(evaluation.permissions) === bit && evaluation.value === true)
  return allowed(VIEW_SUBSCRIPTIONS) && allowed(EDIT_SUBSCRIPTIONS)
}

// ── Subscriptions (§11.2) ──────────────────────────────────────────────────

/** What one delivery kind subscribes to: its event type, the filters beyond project and repository, and whether the resource is minimal. */
const KIND_SHAPE: {
  readonly [K in AzureDevOpsDeliveryKind]: { eventType: string; filters: Record<string, string>; minimal: boolean }
} = {
  opened: { eventType: 'git.pullrequest.created', filters: {}, minimal: false },
  revision: { eventType: 'git.pullrequest.updated', filters: { notificationType: 'PushNotification' }, minimal: true },
  // Reviewers and state send the whole resource: the relay gates them on the pull request's author (§11.4).
  reviewers: {
    eventType: 'git.pullrequest.updated',
    filters: { notificationType: 'ReviewersUpdateNotification' },
    minimal: false
  },
  state: {
    eventType: 'git.pullrequest.updated',
    filters: { notificationType: 'StatusUpdateNotification' },
    minimal: false
  },
  merged: { eventType: 'git.pullrequest.merged', filters: { mergeResult: 'Succeeded' }, minimal: true },
  comment: { eventType: 'ms.vss-code.git-pullrequest-comment-event', filters: {}, minimal: false },
  push: { eventType: 'git.push', filters: {}, minimal: true }
}

/** The binding facts and the key a subscription is written with. */
export interface AzureDevOpsSubscriptionTarget {
  projectId: string
  repositoryId: string
  /** The relay's `/webhooks/azure-devops` address. */
  url: string
  /** The signing key the relay verifies as the Basic password; secret material. */
  password: string
}

export interface AzureDevOpsSubscriptionBody {
  publisherId: 'tfs'
  eventType: string
  resourceVersion: '1.0'
  consumerId: 'webHooks'
  consumerActionId: 'httpRequest'
  publisherInputs: Record<string, string>
  consumerInputs: Record<string, string>
  status?: 'enabled'
}

/** The non-secret consumer inputs a kind is written with; "all" resource details is the input left out (§11.2). */
function consumerInputsOf(kind: AzureDevOpsDeliveryKind, url: string): Record<string, string> {
  return {
    url,
    basicAuthUsername: AZURE_DEVOPS_HOOK_BASIC_USER,
    messagesToSend: 'none',
    detailedMessagesToSend: 'none',
    ...(KIND_SHAPE[kind].minimal ? { resourceDetailsToSend: 'minimal' } : {})
  }
}

function publisherInputsOf(
  kind: AzureDevOpsDeliveryKind,
  target: Pick<AzureDevOpsSubscriptionTarget, 'projectId' | 'repositoryId'>
) {
  return { projectId: target.projectId, repository: target.repositoryId, ...KIND_SHAPE[kind].filters }
}

/** The whole subscription a kind is created or replaced with, the real key included; a read's masked password is never sent back. */
export function subscriptionBody(
  kind: AzureDevOpsDeliveryKind,
  target: AzureDevOpsSubscriptionTarget
): AzureDevOpsSubscriptionBody {
  return {
    publisherId: 'tfs',
    eventType: KIND_SHAPE[kind].eventType,
    resourceVersion: '1.0',
    consumerId: 'webHooks',
    consumerActionId: 'httpRequest',
    publisherInputs: publisherInputsOf(kind, target),
    consumerInputs: { ...consumerInputsOf(kind, target.url), basicAuthPassword: target.password }
  }
}

/** A subscription as Azure DevOps answers it; the password reads as a mask. */
export interface AzureDevOpsSubscription {
  id: string
  status: string | null
  eventType: string | null
  publisherId: string | null
  consumerId: string | null
  consumerActionId: string | null
  resourceVersion: string | null
  publisherInputs: Record<string, string>
  consumerInputs: Record<string, string>
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const [key, entry] of Object.entries(value)) if (typeof entry === 'string') out[key] = entry
  return out
}

function toSubscription(raw: unknown): AzureDevOpsSubscription {
  const r = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  if (!isGuid(r.id))
    throw new AzureDevOpsApiError('Azure DevOps answered a subscription without an id', 200, 'UNAVAILABLE', true)
  return {
    id: r.id.toLowerCase(),
    status: str(r.status),
    eventType: str(r.eventType),
    publisherId: str(r.publisherId),
    consumerId: str(r.consumerId),
    consumerActionId: str(r.consumerActionId),
    resourceVersion: str(r.resourceVersion),
    publisherInputs: stringRecord(r.publisherInputs),
    consumerInputs: stringRecord(r.consumerInputs)
  }
}

// Inputs Azure DevOps adds on its own; an empty value filters nothing.
const BENIGN_PUBLISHER_INPUTS = new Set(['tfsSubscriptionId'])
const BENIGN_CONSUMER_INPUTS: Readonly<Record<string, string>> = { acceptUntrustedCerts: 'false' }

/** Whether a stored subscription no longer matches its recorded kind: event type, publisher inputs, or the non-secret consumer inputs (§11.2). */
export function subscriptionDrifted(
  stored: AzureDevOpsSubscription,
  kind: AzureDevOpsDeliveryKind,
  target: Pick<AzureDevOpsSubscriptionTarget, 'projectId' | 'repositoryId' | 'url'>
): boolean {
  if (stored.eventType !== KIND_SHAPE[kind].eventType) return true
  if (stored.publisherId !== 'tfs' || stored.consumerId !== 'webHooks' || stored.consumerActionId !== 'httpRequest')
    return true
  if (stored.resourceVersion !== null && stored.resourceVersion !== '1.0') return true
  const same = (a: string | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase()
  const publisher = publisherInputsOf(kind, target)
  for (const [key, value] of Object.entries(publisher)) if (!same(stored.publisherInputs[key], value)) return true
  for (const [key, value] of Object.entries(stored.publisherInputs)) {
    if (!(key in publisher) && value !== '' && !BENIGN_PUBLISHER_INPUTS.has(key)) return true
  }
  const consumer = consumerInputsOf(kind, target.url)
  for (const [key, value] of Object.entries(consumer)) {
    // The URL is compared exactly: a host or path that differs only in case is still another address.
    if (key === 'url' ? stored.consumerInputs[key] !== value : !same(stored.consumerInputs[key], value)) return true
  }
  // "All" details is the input left out; a stored `all` means the same.
  const details = stored.consumerInputs.resourceDetailsToSend
  if (
    !('resourceDetailsToSend' in consumer) &&
    details !== undefined &&
    details !== '' &&
    details.toLowerCase() !== 'all'
  )
    return true
  for (const [key, value] of Object.entries(stored.consumerInputs)) {
    if (key in consumer || key === 'basicAuthPassword' || key === 'resourceDetailsToSend' || value === '') continue
    if (BENIGN_CONSUMER_INPUTS[key] !== undefined && same(value, BENIGN_CONSUMER_INPUTS[key])) continue
    return true
  }
  return false
}

/** A status under which Azure DevOps drops new events: any disable, and probation (§11.2). */
export function subscriptionDropping(status: string | null): boolean {
  const lower = status?.toLowerCase() ?? ''
  return lower.startsWith('disabled') || lower === 'onprobation'
}

/** Disabled because its owner lost the permission: the missing grant of §11.1. */
export function disabledForGrant(status: string | null): boolean {
  return status?.toLowerCase() === 'disabledbyinactiveidentity'
}

const subscriptionsUrl = (client: AzureDevOpsApiClient, organization: string, id?: string) =>
  `${client.devOpsBaseUrl}/${encodeURIComponent(organization)}/_apis/hooks/subscriptions${id ? `/${encodeURIComponent(id)}` : ''}?api-version=${API_VERSION}`

export async function createSubscription(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string,
  body: AzureDevOpsSubscriptionBody
): Promise<AzureDevOpsSubscription> {
  const json = await azureDevOpsCall<unknown>(client, token, organization, subscriptionsUrl(client, organization), {
    method: 'POST',
    body
  })
  return toSubscription(json)
}

/** One subscription by id; null when Azure DevOps no longer has it. */
export async function readSubscription(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string,
  id: string
): Promise<AzureDevOpsSubscription | null> {
  try {
    const json = await azureDevOpsCall<unknown>(client, token, organization, subscriptionsUrl(client, organization, id))
    return json === undefined ? null : toSubscription(json)
  } catch (e) {
    if (e instanceof AzureDevOpsApiError && e.code === 'NOT_FOUND') return null
    throw e
  }
}

/** Replace a subscription whole, enabled, with the real key (§11.2). */
export async function replaceSubscription(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string,
  id: string,
  body: AzureDevOpsSubscriptionBody
): Promise<AzureDevOpsSubscription> {
  const json = await azureDevOpsCall<unknown>(client, token, organization, subscriptionsUrl(client, organization, id), {
    method: 'PUT',
    body: { ...body, id, status: 'enabled' }
  })
  if (json !== undefined) return toSubscription(json)
  const stored = await readSubscription(client, token, organization, id)
  if (!stored) throw new AzureDevOpsApiError('not found in Azure DevOps', 404, 'NOT_FOUND', false)
  return stored
}

/** Delete a subscription; one already gone counts as deleted. */
export async function deleteSubscription(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string,
  id: string
): Promise<void> {
  try {
    await azureDevOpsCall<unknown>(client, token, organization, subscriptionsUrl(client, organization, id), {
      method: 'DELETE'
    })
  } catch (e) {
    if (e instanceof AzureDevOpsApiError && e.code === 'NOT_FOUND') return
    throw e
  }
}

// ── The membership gate's reads (§11.4) ─────────────────────────────────────

/** An identity and every group it belongs to, directly or not, by descriptor. */
export interface AzureDevOpsIdentityMemberships {
  descriptor: string
  memberOf: string[]
}

/** A descriptor as a string, from either the string form or the `{ identityType, identifier }` form. */
function descriptorOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value
  const r = value as { identityType?: unknown; identifier?: unknown } | null
  if (r && typeof r.identityType === 'string' && typeof r.identifier === 'string')
    return `${r.identityType};${r.identifier}`
  return null
}

/** `queryMembership=ExpandedUp`: the actor's descriptor and its transitive groups; null when no such identity. */
export async function readIdentityMemberships(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string,
  identityId: string
): Promise<AzureDevOpsIdentityMemberships | null> {
  const url = `${IDENTITIES_BASE}/${encodeURIComponent(organization)}/_apis/identities?identityIds=${encodeURIComponent(identityId)}&queryMembership=ExpandedUp&api-version=${API_VERSION}`
  const json = await azureDevOpsCall<{ value?: unknown[] }>(client, token, organization, url)
  const first = (Array.isArray(json?.value) ? json.value : []).find(
    (entry) => typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id !== undefined
  ) as { id?: unknown; descriptor?: unknown; memberOf?: unknown } | undefined
  if (!first || !isGuid(first.id) || first.id.toLowerCase() !== identityId.toLowerCase()) return null
  const descriptor = descriptorOf(first.descriptor)
  if (!descriptor) return null
  const memberOf = (Array.isArray(first.memberOf) ? first.memberOf : [])
    .map(descriptorOf)
    .filter((d): d is string => d !== null)
  return { descriptor, memberOf }
}

/** One access-control list as the gate reads it; `exists` is false when the token has no list of its own. */
export interface AzureDevOpsAccessControlList {
  exists: boolean
  /** Absent when the answer leaves it out, which the gate reads as a boundary. */
  inheritPermissions: boolean | undefined
  /** Descriptor (lowercase) → its allow and deny bits. */
  aces: Map<string, { allow: number; deny: number }>
}

/** The Git Repositories namespace's list on one token, without its children and without extended info (§11.4). */
export async function readGitAccessControlList(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string,
  securityToken: string
): Promise<AzureDevOpsAccessControlList> {
  const url = `${client.devOpsBaseUrl}/${encodeURIComponent(organization)}/_apis/accesscontrollists/${GIT_REPOSITORIES_NAMESPACE}?token=${encodeURIComponent(securityToken)}&includeExtendedInfo=false&recurse=false&api-version=${API_VERSION}`
  const json = await azureDevOpsCall<{ value?: unknown[] }>(client, token, organization, url)
  const lists = (Array.isArray(json?.value) ? json.value : []) as Array<{
    token?: unknown
    inheritPermissions?: unknown
    acesDictionary?: unknown
  }>
  // `recurse=false` answers the token's own list; one naming another token is not this level's.
  const list = lists.find(
    (entry) => typeof entry.token !== 'string' || entry.token.toLowerCase() === securityToken.toLowerCase()
  )
  if (!list) return { exists: false, inheritPermissions: undefined, aces: new Map() }
  const aces = new Map<string, { allow: number; deny: number }>()
  const dictionary = (list.acesDictionary ?? {}) as Record<
    string,
    { descriptor?: unknown; allow?: unknown; deny?: unknown }
  >
  for (const [key, ace] of Object.entries(dictionary)) {
    const descriptor = typeof ace?.descriptor === 'string' ? ace.descriptor : key
    aces.set(descriptor.toLowerCase(), { allow: Number(ace?.allow) || 0, deny: Number(ace?.deny) || 0 })
  }
  return {
    exists: true,
    inheritPermissions: typeof list.inheritPermissions === 'boolean' ? list.inheritPermissions : undefined,
    aces
  }
}
