/** Azure DevOps service hook normalization (azure-devops-integration.md §11.3, §11.4), the pure half of the ingress; untrusted beyond filter input. */
import {
  AZURE_DEVOPS_HOOK_BASIC_USER,
  codeHostSubjectBody,
  type AzureDevOpsDeliveryKind,
  type AzureDevOpsHookMetadata,
  type AzureDevOpsHookTarget,
  type HookContext,
  type RcAzureDevOpsHookRule,
  type RcHookAssign
} from '@agentconnect.md/protocol'
import { mentionsGithubHandle, truncateUtf8, GITHUB_BODY_EXCERPT_MAX } from '../github-ingress.js'
import { verifyBasicAuthorization } from '../signature.js'

/** The `eventType` each subscription kind is created with (§11.2); a body naming another is refused. */
export const AZURE_DEVOPS_EVENT_TYPES: { readonly [K in AzureDevOpsDeliveryKind]: string } = {
  opened: 'git.pullrequest.created',
  revision: 'git.pullrequest.updated',
  reviewers: 'git.pullrequest.updated',
  state: 'git.pullrequest.updated',
  merged: 'git.pullrequest.merged',
  comment: 'ms.vss-code.git-pullrequest-comment-event',
  push: 'git.push'
}

/** The normalized event each kind is forwarded as; the update kinds name what was delivered, never a classification the body cannot carry. */
export const AZURE_DEVOPS_EVENT_ACTIONS: { readonly [K in AzureDevOpsDeliveryKind]: string } = {
  opened: 'merge_request:opened',
  revision: 'merge_request:synchronize',
  reviewers: 'merge_request:review_requested',
  state: 'merge_request:state_changed',
  merged: 'merge_request:merged',
  comment: 'note:created',
  push: 'push'
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const ORGANIZATION_SOURCE = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?'
/** A minimal pull-request resource's `url`: organization, project GUID, repository GUID, id. */
const PULL_REQUEST_URL = new RegExp(
  `^https://dev\\.azure\\.com/${ORGANIZATION_SOURCE}/(${GUID_SOURCE})/_apis/git/repositories/(${GUID_SOURCE})/pullRequests/([1-9]\\d{0,9})$`
)
/** A comment's `_links.threads.href`, which names no project (verified 2026-11-07). */
const COMMENT_THREAD_URL = new RegExp(
  `^https://dev\\.azure\\.com/${ORGANIZATION_SOURCE}/_apis/git/repositories/(${GUID_SOURCE})/pullRequests/([1-9]\\d{0,9})/threads/([1-9]\\d{0,9})$`
)
/** A comment's `_links.pullRequests.href`, checked against the thread link when present. */
const COMMENT_PULL_REQUEST_URL = new RegExp(
  `^https://dev\\.azure\\.com/${ORGANIZATION_SOURCE}/_apis/git/pullRequests/([1-9]\\d{0,9})$`
)
/** The connection identity as a comment's content stores its mention: `@<{identity id}>`. */
const IDENTITY_MENTION = new RegExp(`@<(${GUID_SOURCE})>`, 'g')
/** A deleted ref's new object id. */
const ZERO_OBJECT_ID = /^0+$/

interface AzureDevOpsIdentityRef {
  id?: unknown
  displayName?: unknown
}

/** The envelope fields the ingress reads; everything is unknown until checked. */
export interface AzureDevOpsEnvelope {
  subscriptionId?: unknown
  id?: unknown
  eventType?: unknown
  publisherId?: unknown
  resource?: unknown
  resourceContainers?: { collection?: { id?: unknown }; project?: { id?: unknown } } | null
}

/** Which of a rule's keys a delivery's Basic credentials match; null when none does or the previous key has expired. */
export function azureDevOpsVerifiedKey(
  rule: RcAzureDevOpsHookRule,
  authorization: string | undefined,
  nowMs: number
): 'current' | 'next' | 'previous' | null {
  const verify = (key: string): boolean => verifyBasicAuthorization(AZURE_DEVOPS_HOOK_BASIC_USER, key, authorization)
  if (verify(rule.signingKey)) return 'current'
  if (rule.nextSigningKey !== undefined && verify(rule.nextSigningKey)) return 'next'
  const expiresAt = rule.previousSigningKeyExpiresAt ? Date.parse(rule.previousSigningKeyExpiresAt) : NaN
  if (rule.previousSigningKey !== undefined && nowMs < expiresAt && verify(rule.previousSigningKey)) return 'previous'
  return null
}

/** The kind a rule records for one subscription id; undefined when it records none. */
export function azureDevOpsSubscriptionKind(
  rule: RcHookAssign,
  subscriptionId: string
): AzureDevOpsDeliveryKind | undefined {
  if (rule.kind !== 'azure-devops' || !rule.azureDevOps) return undefined
  const id = subscriptionId.toLowerCase()
  return rule.azureDevOps.subscriptions.find((subscription) => subscription.subscriptionId.toLowerCase() === id)?.kind
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function guidOf(value: unknown): string | undefined {
  return typeof value === 'string' && GUID.test(value) ? value.toLowerCase() : undefined
}

function sameGuid(value: unknown, expected: string): boolean {
  return guidOf(value) === expected.toLowerCase()
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function linkHref(links: Record<string, unknown> | undefined, name: string): string | undefined {
  const href = record(links?.[name])?.href
  return typeof href === 'string' ? href : undefined
}

function identityOf(value: unknown): { id?: string; name?: string } {
  const ref = record(value) as AzureDevOpsIdentityRef | undefined
  const id = guidOf(ref?.id)
  const name = typeof ref?.displayName === 'string' && ref.displayName.length > 0 ? ref.displayName : undefined
  return { ...(id ? { id } : {}), ...(name ? { name } : {}) }
}

/** One delivery's checked facts; the kind comes from the subscription, never the body. */
export interface AzureDevOpsMatchCtx {
  deliveryKind: AzureDevOpsDeliveryKind
  eventAction: string
  family: 'merge_request' | 'note' | 'push'
  actorId?: string
  actorName?: string
  mentionText?: string
  pullRequestId?: number
  threadId?: number
  commentId?: number
  /** Reviewers and state only: the pull request's author, whom the membership gate reads for an update that names no actor. */
  authorId?: string
  /** Opened, reviewers and state: the pull request comes from a fork, so the identity's own lane does not apply. */
  fromFork?: boolean
  headSha?: string
  isDraft?: boolean
  title?: string
  status?: string
  /** Push only: the refs the push moved, deletions left out. */
  refs?: string[]
  /** Comment only: a `text` comment that was just published — not a system comment, an edit, a like or a deletion. */
  admitted: boolean
}

/** The pull request a pull-request resource names, or undefined when it names another repository or none (§11.3 step 4). */
function pullRequestOf(resource: Record<string, unknown>, rule: RcAzureDevOpsHookRule): number | undefined {
  const pullRequestId = positiveInt(resource.pullRequestId)
  if (pullRequestId === undefined) return undefined
  const url = resource.url
  const repository = record(resource.repository)
  if (url === undefined && repository === undefined) return undefined
  if (url !== undefined) {
    const match = typeof url === 'string' ? PULL_REQUEST_URL.exec(url) : null
    if (!match || !sameGuid(match[1], rule.projectId) || !sameGuid(match[2], rule.repositoryId)) return undefined
    if (Number(match[3]) !== pullRequestId) return undefined
  }
  if (repository !== undefined && !repositoryAgrees(repository, rule)) return undefined
  return pullRequestId
}

/** A resource's repository is the rule's: its GUID always, its project's when the resource names one. */
function repositoryAgrees(repository: Record<string, unknown>, rule: RcAzureDevOpsHookRule): boolean {
  if (!sameGuid(repository.id, rule.repositoryId)) return false
  const project = record(repository.project)
  return project?.id === undefined || sameGuid(project.id, rule.projectId)
}

/** Check a verified body against the rule that verified it and normalize it; undefined refuses it (§11.3 step 4). */
export function checkAzureDevOpsDelivery(
  envelope: AzureDevOpsEnvelope,
  rule: RcAzureDevOpsHookRule,
  kind: AzureDevOpsDeliveryKind
): AzureDevOpsMatchCtx | undefined {
  if (envelope.eventType !== AZURE_DEVOPS_EVENT_TYPES[kind] || envelope.publisherId !== 'tfs') return undefined
  const containers = record(envelope.resourceContainers)
  if (!sameGuid(record(containers?.collection)?.id, rule.instanceId)) return undefined
  if (!sameGuid(record(containers?.project)?.id, rule.projectId)) return undefined
  const resource = record(envelope.resource)
  if (!resource) return undefined
  const base = { deliveryKind: kind, eventAction: AZURE_DEVOPS_EVENT_ACTIONS[kind] }

  if (kind === 'push') {
    const repository = record(resource.repository)
    if (!repository || !repositoryAgrees(repository, rule)) return undefined
    const updates = Array.isArray(resource.refUpdates) ? resource.refUpdates : []
    const refs = updates.flatMap((update) => {
      const ref = record(update)
      const name = ref?.name
      const next = ref?.newObjectId
      if (typeof name !== 'string' || name.length === 0 || name.length > 400) return []
      return typeof next === 'string' && ZERO_OBJECT_ID.test(next) ? [] : [name]
    })
    const actor = identityOf(resource.pushedBy)
    return {
      ...base,
      family: 'push',
      ...(actor.id ? { actorId: actor.id } : {}),
      ...(actor.name ? { actorName: actor.name } : {}),
      refs: [...new Set(refs)],
      admitted: true
    }
  }

  if (kind === 'comment') {
    const links = record(resource._links)
    const thread = COMMENT_THREAD_URL.exec(linkHref(links, 'threads') ?? '')
    if (!thread || !sameGuid(thread[1], rule.repositoryId)) return undefined
    const pullRequestId = Number(thread[2])
    const pullHref = linkHref(links, 'pullRequests')
    if (pullHref !== undefined && Number(COMMENT_PULL_REQUEST_URL.exec(pullHref)?.[1]) !== pullRequestId) {
      return undefined
    }
    const commentId = positiveInt(resource.id)
    if (commentId === undefined) return undefined
    const actor = identityOf(resource.author)
    const content = typeof resource.content === 'string' ? resource.content : undefined
    const published = resource.publishedDate
    // A like or an edit re-delivers the comment with a later `lastContentUpdatedDate` or the same content; only a new one is admitted.
    const isNew = typeof published === 'string' && published.length > 0 && resource.lastContentUpdatedDate === published
    return {
      ...base,
      family: 'note',
      ...(actor.id ? { actorId: actor.id } : {}),
      ...(actor.name ? { actorName: actor.name } : {}),
      ...(content !== undefined ? { mentionText: content } : {}),
      pullRequestId,
      threadId: Number(thread[3]),
      commentId,
      admitted: resource.commentType === 'text' && resource.isDeleted !== true && isNew && content !== undefined
    }
  }

  const pullRequestId = pullRequestOf(resource, rule)
  if (pullRequestId === undefined) return undefined
  if (kind === 'reviewers' || kind === 'state') {
    // §11.4: these name no actor, so the pull request's author is what the gate reads; the update stays unclassified.
    const author = identityOf(resource.createdBy)
    return {
      ...base,
      family: 'merge_request',
      ...(author.id ? { authorId: author.id } : {}),
      fromFork: resource.forkSource !== undefined && resource.forkSource !== null,
      pullRequestId,
      admitted: true
    }
  }
  if (kind !== 'opened') return { ...base, family: 'merge_request', pullRequestId, admitted: true }
  const actor = identityOf(resource.createdBy)
  const headSha = record(resource.lastMergeSourceCommit)?.commitId
  return {
    ...base,
    family: 'merge_request',
    ...(actor.id ? { actorId: actor.id } : {}),
    ...(actor.name ? { actorName: actor.name } : {}),
    ...(typeof resource.description === 'string' ? { mentionText: resource.description } : {}),
    pullRequestId,
    fromFork: resource.forkSource !== undefined && resource.forkSource !== null,
    ...(typeof headSha === 'string' && headSha.length > 0 ? { headSha } : {}),
    ...(typeof resource.isDraft === 'boolean' ? { isDraft: resource.isDraft } : {}),
    ...(typeof resource.title === 'string' ? { title: resource.title } : {}),
    ...(typeof resource.status === 'string' ? { status: resource.status } : {}),
    admitted: true
  }
}

/** Whether a text mentions the connection identity, the repository-wide broadcast (§11.4). */
export function mentionsAzureDevOpsIdentity(text: string | undefined, identityId: string): boolean {
  if (!text) return false
  const wanted = identityId.toLowerCase()
  for (const match of text.matchAll(IDENTITY_MENTION)) if (match[1]!.toLowerCase() === wanted) return true
  return false
}

function mentionsAgent(text: string | undefined, rule: RcHookAssign): boolean {
  return mentionsGithubHandle(text, rule.azureDevOps?.agentName)
}

export function azureDevOpsRuleIsSummoned(rule: RcHookAssign, ctx: AzureDevOpsMatchCtx): boolean {
  const azure = rule.azureDevOps
  if (!azure) return false
  return mentionsAzureDevOpsIdentity(ctx.mentionText, azure.identityId) || mentionsAgent(ctx.mentionText, rule)
}

/** Explicit agent handles narrow a repository fan-out; the connection identity's mention is the broadcast form. */
export function azureDevOpsMentionCandidates(rules: RcHookAssign[], text: string | undefined): RcHookAssign[] {
  if (rules.some((rule) => rule.azureDevOps && mentionsAzureDevOpsIdentity(text, rule.azureDevOps.identityId))) {
    return rules
  }
  const targeted = new Set(rules.filter((rule) => mentionsAgent(text, rule)).map((rule) => rule.agentId))
  return targeted.size === 0 ? rules : rules.filter((rule) => targeted.has(rule.agentId))
}

function matchesPattern(rule: RcAzureDevOpsHookRule, eventAction: string): boolean {
  const colon = eventAction.indexOf(':')
  const family = colon === -1 ? eventAction : eventAction.slice(0, colon)
  return (colon !== -1 && rule.events.includes(eventAction)) || rule.events.includes(`${family}:*`)
}

/** Whether a rule watches pull requests at all: any pull-request event or the pull-request comment family. */
export function azureDevOpsRuleCoversPullRequests(rule: RcHookAssign): boolean {
  const azure = rule.kind === 'azure-devops' ? rule.azureDevOps : undefined
  if (!azure) return false
  return (
    azure.events.some((event) => event.startsWith('merge_request:')) ||
    (azure.commentFamilies ?? []).includes('pull_request')
  )
}

/** A state delivery starts a turn for this rule if the daemon finds the pull request reopened (§11.4). */
export function azureDevOpsRuleAdmitsReopened(rule: RcHookAssign): boolean {
  const azure = rule.kind === 'azure-devops' ? rule.azureDevOps : undefined
  return !!azure && !azure.mentionOnly && matchesPattern(azure, 'merge_request:reopened')
}

/** §11.4 internal lane: the identity's own pull request from this repository enters review without the gate. */
export function isInternalAzureDevOpsPull(rule: RcHookAssign, ctx: AzureDevOpsMatchCtx): boolean {
  return (
    ctx.deliveryKind === 'opened' &&
    ctx.actorId !== undefined &&
    ctx.actorId === rule.azureDevOps?.identityId &&
    ctx.fromFork === false
  )
}

/** §11.4: an update kind is gated on the pull request's author, except the identity's own same-repository pull request. */
export function azureDevOpsUpdateVerdict(rule: RcHookAssign, ctx: AzureDevOpsMatchCtx): 'trusted' | 'needs-authz' {
  const own = ctx.authorId !== undefined && ctx.authorId === rule.azureDevOps?.identityId && ctx.fromFork === false
  return own ? 'trusted' : 'needs-authz'
}

export type AzureDevOpsRuleVerdict = 'no-match' | 'trusted' | 'needs-authz'

/** One rule's verdict for an opened, revision, comment or push delivery: loop veto → cadence/summon → comment scope → mention-only → authz. */
export function azureDevOpsRuleVerdict(rule: RcHookAssign, ctx: AzureDevOpsMatchCtx): AzureDevOpsRuleVerdict {
  const azure = rule.kind === 'azure-devops' ? rule.azureDevOps : undefined
  if (!azure || !ctx.admitted) return 'no-match'
  // §11.4 loop prevention: the identity never re-triggers, except its own same-repository pull request.
  const internal = isInternalAzureDevOpsPull(rule, ctx)
  if (ctx.actorId !== undefined && ctx.actorId === azure.identityId && !internal) return 'no-match'
  const summoned = azureDevOpsRuleIsSummoned(rule, ctx)
  let eventMatched: boolean
  if (ctx.family === 'note') {
    const createdCadenceSummon = summoned && azure.events.includes('merge_request:opened')
    eventMatched = (azure.commentFamilies ?? []).includes('pull_request') || createdCadenceSummon
  } else {
    const createdCadenceSummon =
      summoned && ctx.family === 'merge_request' && azure.events.includes('merge_request:opened')
    eventMatched = matchesPattern(azure, ctx.eventAction) || createdCadenceSummon
  }
  if (!eventMatched) return 'no-match'
  if (azure.mentionOnly && !summoned) return 'no-match'
  // A push and a revision already took Contribute; the identity's own pull request is its own lane.
  if (ctx.family === 'push' || ctx.deliveryKind === 'revision' || internal) return 'trusted'
  return 'needs-authz'
}

/** The rename-stable session key: the pull request by id, or the pushed ref. */
export function azureDevOpsSessionKey(rule: RcHookAssign, target: AzureDevOpsHookTarget): string {
  const prefix = rule.azureDevOps!.sessionKeyPrefix
  return target.kind === 'push' ? `${prefix}:push:${target.ref}` : `${prefix}:pull:${target.pullRequestId}`
}

/** The checked subject → trusted `RdMsgHook.azureDevOps`, every identifier copied from the rule; incomplete identity is rejected. */
export function buildTrustedAzureDevOpsMetadata(
  ctx: AzureDevOpsMatchCtx,
  rule: RcHookAssign,
  extra: { ref?: string; admitsReopened?: boolean } = {}
): AzureDevOpsHookMetadata | undefined {
  const azure = rule.kind === 'azure-devops' ? rule.azureDevOps : undefined
  if (!azure) return undefined
  let target: AzureDevOpsHookTarget
  if (ctx.family === 'push') {
    if (!extra.ref) return undefined
    target = { kind: 'push', ref: extra.ref }
  } else {
    if (ctx.pullRequestId === undefined) return undefined
    target = {
      kind: 'pull',
      pullRequestId: ctx.pullRequestId,
      ...(ctx.headSha ? { headSha: ctx.headSha } : {}),
      ...(ctx.isDraft !== undefined ? { isDraft: ctx.isDraft } : {}),
      ...(extra.admitsReopened !== undefined ? { admitsReopened: extra.admitsReopened } : {})
    }
  }
  return {
    repoId: azure.repoId,
    repoPath: azure.repoPath,
    organization: azure.organization,
    projectId: azure.projectId,
    repositoryId: azure.repositoryId,
    deliveryKind: ctx.deliveryKind,
    target,
    ...(ctx.threadId !== undefined ? { threadId: String(ctx.threadId) } : {}),
    ...(ctx.commentId !== undefined ? { commentId: String(ctx.commentId) } : {})
  }
}

function flatten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat
}

/** The trimmed model-visible envelope; an update kind carries only its identifiers, and the daemon reads the rest. */
export function buildAzureDevOpsContext(rule: RcHookAssign, ctx: AzureDevOpsMatchCtx, ref?: string): HookContext {
  const excerpt = truncateUtf8(ctx.mentionText ?? '', GITHUB_BODY_EXCERPT_MAX)
  const colon = ctx.eventAction.indexOf(':')
  const title = ctx.title ? flatten(ctx.title) : undefined
  const subjectBody = ctx.deliveryKind === 'opened' && ctx.mentionText ? codeHostSubjectBody(ctx.mentionText) : {}
  return {
    source: 'azure-devops',
    event: ctx.family,
    ...(colon !== -1 ? { action: ctx.eventAction.slice(colon + 1) } : {}),
    ...(rule.azureDevOps ? { repo: rule.azureDevOps.repoPath } : {}),
    ...(ctx.pullRequestId !== undefined ? { number: ctx.pullRequestId } : {}),
    ...(title ? { title } : {}),
    ...(ctx.actorName ? { senderLogin: flatten(ctx.actorName) } : {}),
    ...(ref ? { ref } : {}),
    ...(excerpt.text ? { bodyExcerpt: excerpt.text } : {}),
    ...(ctx.deliveryKind === 'opened'
      ? {
          subject: {
            ...(ctx.actorName ? { authorLogin: flatten(ctx.actorName) } : {}),
            ...(ctx.status ? { state: ctx.status } : {}),
            ...(ctx.isDraft !== undefined ? { draft: ctx.isDraft } : {}),
            ...subjectBody
          }
        }
      : {}),
    truncated: excerpt.truncated
  }
}
