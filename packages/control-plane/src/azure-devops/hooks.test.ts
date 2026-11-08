// Pure rules of Azure DevOps service hooks (azure-devops-integration.md §11.2, §11.4): subscription shapes, drift, the kinds a repository needs, and the inheritance boundaries of the membership gate.
import { describe, expect, it } from 'vitest'
import {
  subscriptionBody,
  subscriptionDropping,
  subscriptionDrifted,
  disabledForGrant,
  type AzureDevOpsAccessControlList,
  type AzureDevOpsSubscription
} from './hooks-api.js'
import { azureDevOpsDeliveryKinds, hookBindingOf } from './hook.service.js'
import { contributeAdmits, effectiveLists, gitTokenChain } from './membership-authz.service.js'

const PROJECT = '00000000-0000-4000-8000-000000000001'
const REPOSITORY = '00000000-0000-4000-8000-000000000002'
const URL = 'https://relay.example.test/webhooks/azure-devops'
const TARGET = { projectId: PROJECT, repositoryId: REPOSITORY, url: URL, password: 'example-key' }

/** What Azure DevOps answers for a subscription written with `body`: the password masked. */
function stored(
  kind: Parameters<typeof subscriptionBody>[0],
  over: Partial<AzureDevOpsSubscription> = {}
): AzureDevOpsSubscription {
  const body = subscriptionBody(kind, TARGET)
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    status: 'enabled',
    eventType: body.eventType,
    publisherId: body.publisherId,
    consumerId: body.consumerId,
    consumerActionId: body.consumerActionId,
    resourceVersion: body.resourceVersion,
    publisherInputs: { ...body.publisherInputs, tfsSubscriptionId: 'x' },
    consumerInputs: { ...body.consumerInputs, basicAuthPassword: '********' },
    ...over
  }
}

describe('subscription bodies (§11.2)', () => {
  it('writes each kind with its event type, filters and resource details, the key only as the Basic password', () => {
    expect(subscriptionBody('opened', TARGET)).toEqual({
      publisherId: 'tfs',
      eventType: 'git.pullrequest.created',
      resourceVersion: '1.0',
      consumerId: 'webHooks',
      consumerActionId: 'httpRequest',
      publisherInputs: { projectId: PROJECT, repository: REPOSITORY },
      // "All" details is the input left out: an empty string is refused.
      consumerInputs: {
        url: URL,
        basicAuthUsername: 'agentconnect',
        basicAuthPassword: 'example-key',
        messagesToSend: 'none',
        detailedMessagesToSend: 'none'
      }
    })
    expect(subscriptionBody('revision', TARGET).publisherInputs).toEqual({
      projectId: PROJECT,
      repository: REPOSITORY,
      notificationType: 'PushNotification'
    })
    expect(subscriptionBody('reviewers', TARGET).publisherInputs.notificationType).toBe('ReviewersUpdateNotification')
    expect(subscriptionBody('state', TARGET).publisherInputs.notificationType).toBe('StatusUpdateNotification')
    // §11.4: the relay gates these on the pull request's author, so they carry the whole resource.
    for (const kind of ['reviewers', 'state'] as const) {
      expect(subscriptionBody(kind, TARGET).consumerInputs).not.toHaveProperty('resourceDetailsToSend')
    }
    expect(subscriptionBody('merged', TARGET)).toMatchObject({
      eventType: 'git.pullrequest.merged',
      publisherInputs: { mergeResult: 'Succeeded' },
      consumerInputs: { resourceDetailsToSend: 'minimal' }
    })
    expect(subscriptionBody('comment', TARGET).eventType).toBe('ms.vss-code.git-pullrequest-comment-event')
    expect(subscriptionBody('comment', TARGET).consumerInputs).not.toHaveProperty('resourceDetailsToSend')
    expect(subscriptionBody('push', TARGET)).toMatchObject({
      eventType: 'git.push',
      consumerInputs: { resourceDetailsToSend: 'minimal' }
    })
    for (const kind of ['opened', 'comment', 'push'] as const) {
      expect(JSON.stringify(subscriptionBody(kind, TARGET).consumerInputs)).not.toContain('httpHeaders')
    }
  })

  it('reads a masked password and Azure DevOps’s own inputs as no drift', () => {
    for (const kind of ['opened', 'revision', 'reviewers', 'state', 'merged', 'comment', 'push'] as const) {
      expect(subscriptionDrifted(stored(kind), kind, TARGET)).toBe(false)
    }
    const all = stored('opened')
    expect(
      subscriptionDrifted(
        { ...all, consumerInputs: { ...all.consumerInputs, resourceDetailsToSend: 'all' } },
        'opened',
        TARGET
      )
    ).toBe(false)
  })

  it('rewrites a reviewers or state subscription still sending the minimal resource', () => {
    for (const kind of ['reviewers', 'state'] as const) {
      const s = stored(kind)
      const minimal = { ...s, consumerInputs: { ...s.consumerInputs, resourceDetailsToSend: 'minimal' } }
      expect(subscriptionDrifted(minimal, kind, TARGET)).toBe(true)
      expect(
        subscriptionDrifted(
          { ...s, consumerInputs: { ...s.consumerInputs, resourceDetailsToSend: 'all' } },
          kind,
          TARGET
        )
      ).toBe(false)
    }
  })

  it('finds drift in the event type, a filter, the address, the user, a header, or the details sent', () => {
    const s = stored('revision')
    const drifted: AzureDevOpsSubscription[] = [
      { ...s, eventType: 'git.pullrequest.created' },
      { ...s, publisherInputs: { ...s.publisherInputs, notificationType: 'ReviewersUpdateNotification' } },
      { ...s, publisherInputs: { ...s.publisherInputs, repository: '00000000-0000-4000-8000-0000000000ff' } },
      { ...s, publisherInputs: { ...s.publisherInputs, branch: 'refs/heads/main' } },
      { ...s, consumerInputs: { ...s.consumerInputs, url: 'https://elsewhere.example.test/webhooks/azure-devops' } },
      { ...s, consumerInputs: { ...s.consumerInputs, basicAuthUsername: 'someone' } },
      { ...s, consumerInputs: { ...s.consumerInputs, httpHeaders: 'X-Example: 1' } },
      { ...s, consumerInputs: { ...s.consumerInputs, resourceDetailsToSend: 'all' } },
      { ...s, consumerInputs: { ...s.consumerInputs, messagesToSend: 'text' } },
      { ...s, consumerActionId: 'serviceBusQueueSend' }
    ]
    for (const candidate of drifted) expect(subscriptionDrifted(candidate, 'revision', TARGET)).toBe(true)
  })

  it('tells the statuses that drop events apart, and the one disabled for the grant', () => {
    expect(
      ['disabledByUser', 'disabledBySystem', 'disabledByInactiveIdentity', 'onProbation'].every(subscriptionDropping)
    ).toBe(true)
    expect(subscriptionDropping('enabled') || subscriptionDropping(null)).toBe(false)
    expect(disabledForGrant('disabledByInactiveIdentity')).toBe(true)
    expect(disabledForGrant('disabledBySystem')).toBe(false)
  })
})

describe('the kinds a repository needs (§11.2)', () => {
  const hook = (over: Record<string, unknown>) => ({
    enabled: true,
    kind: 'azure-devops' as const,
    repoId: 7n,
    events: [] as string[],
    commentFamilies: [] as Array<'merge_request'>,
    ...over
  })

  it('is the union of enabled hooks on the repository, one subscription per kind and never per hook', () => {
    const kinds = azureDevOpsDeliveryKinds(
      [
        hook({ events: ['merge_request:opened'] }),
        hook({ events: ['merge_request:opened', 'merge_request:review_requested'] }),
        hook({ events: ['push:*'] }),
        hook({ events: ['merge_request:*'], enabled: false }),
        hook({ events: ['merge_request:synchronize'], repoId: 8n })
      ],
      7n
    )
    // A pull-request watcher also takes state, for cleanup; never "merge attempted", which fires on opening too.
    expect([...kinds].sort()).toEqual(['opened', 'push', 'reviewers', 'state'])
  })

  it('takes every update kind for a wildcard, the comment kind for the comment family, and nothing for no hook', () => {
    expect([...azureDevOpsDeliveryKinds([hook({ events: ['merge_request:*'] })], 7n)].sort()).toEqual([
      'opened',
      'reviewers',
      'revision',
      'state'
    ])
    expect([...azureDevOpsDeliveryKinds([hook({ commentFamilies: ['merge_request'] })], 7n)].sort()).toEqual([
      'comment',
      'state'
    ])
    expect(azureDevOpsDeliveryKinds([hook({ events: ['push:*'], kind: 'gitea' })], 7n).size).toBe(0)
  })

  it('puts subscriptions on the oldest binding only', () => {
    const older = { id: 'a', createdAt: new Date(1) }
    const newer = { id: 'b', createdAt: new Date(2) }
    expect(hookBindingOf([newer, older])).toBe(older)
    expect(hookBindingOf([])).toBeUndefined()
  })
})

describe('the membership gate (§11.4)', () => {
  const ME = 'Microsoft.IdentityModel.Claims.ClaimsIdentity;tenant\\person@example.test'
  const CONTRIBUTORS = 'Microsoft.TeamFoundation.Identity;S-1-9-1551374245-1'
  const VALID_USERS = 'Microsoft.TeamFoundation.Identity;S-1-9-1551374245-2'
  const list = (
    inheritPermissions: boolean | undefined,
    aces: Record<string, { allow: number; deny: number }>,
    exists = true
  ): AzureDevOpsAccessControlList => ({
    exists,
    inheritPermissions,
    aces: new Map(Object.entries(aces).map(([d, ace]) => [d.toLowerCase(), ace]))
  })

  it('reads the repository, its project, then the namespace root', () => {
    expect(gitTokenChain(PROJECT, REPOSITORY)).toEqual([
      `repoV2/${PROJECT}/${REPOSITORY}`,
      `repoV2/${PROJECT}`,
      'repoV2'
    ])
  })

  it('admits an allow on the actor’s group through an inheriting chain, and refuses a deny anywhere on it', () => {
    const chain = [list(true, {}), list(true, { [CONTRIBUTORS]: { allow: 4 | 2, deny: 0 } }), list(undefined, {})]
    expect(contributeAdmits(effectiveLists(chain), [ME, CONTRIBUTORS])).toBe(true)
    const denied = [list(true, { [VALID_USERS]: { allow: 0, deny: 4 } }), ...chain.slice(1)]
    expect(contributeAdmits(effectiveLists(denied), [ME, CONTRIBUTORS, VALID_USERS])).toBe(false)
    // A read-only allow is no contribute allow.
    expect(contributeAdmits(effectiveLists([list(false, { [ME]: { allow: 2, deny: 0 } })]), [ME])).toBe(false)
  })

  it('takes no ancestor allow beyond a repository or project that does not inherit', () => {
    const projectAllows = list(true, { [CONTRIBUTORS]: { allow: 4, deny: 0 } })
    const repoBoundary = [list(false, {}), projectAllows, list(true, {})]
    expect(effectiveLists(repoBoundary)).toHaveLength(1)
    expect(contributeAdmits(effectiveLists(repoBoundary), [ME, CONTRIBUTORS])).toBe(false)
    const rootAllows = list(undefined, { [CONTRIBUTORS]: { allow: 4, deny: 0 } })
    const projectBoundary = [list(true, {}), list(false, {}), rootAllows]
    expect(contributeAdmits(effectiveLists(projectBoundary), [ME, CONTRIBUTORS])).toBe(false)
    // An answer that leaves inheritance out is a boundary too.
    const unknown = [list(undefined, {}), projectAllows]
    expect(contributeAdmits(effectiveLists(unknown), [ME, CONTRIBUTORS])).toBe(false)
  })

  it('reads a level with no list of its own as inheriting, as Azure DevOps does', () => {
    const chain = [list(undefined, {}, false), list(true, { [CONTRIBUTORS]: { allow: 4, deny: 0 } })]
    expect(contributeAdmits(effectiveLists(chain), [ME, CONTRIBUTORS])).toBe(true)
  })

  it('counts only the actor and its groups, compared without case', () => {
    const chain = [list(false, { [CONTRIBUTORS.toUpperCase()]: { allow: 4, deny: 0 } })]
    expect(contributeAdmits(effectiveLists(chain), [ME, CONTRIBUTORS])).toBe(true)
    expect(contributeAdmits(effectiveLists(chain), [ME, VALID_USERS])).toBe(false)
  })
})
