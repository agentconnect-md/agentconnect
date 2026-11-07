import { describe, expect, it } from 'vitest'
import {
  AZURE_DEVOPS_HOOKS_V1_FEATURE,
  AZURE_DEVOPS_HOOK_BASIC_USER,
  AZURE_DEVOPS_V1_FEATURE,
  AgentAdditionalRepo,
  AzureDevOpsHookMetadata,
  AgentWorkspace,
  AgentWorkspaceCredential,
  AzureDevOpsRepoRouting,
  CODE_HOST_PROVIDERS,
  GitCredGrant,
  GitCredRequest,
  HOOK_KINDS,
  HookReport,
  HookStart,
  RcCodeHostDelivery,
  RcCodeHostMembershipAuthz,
  RcHookAssign,
  RcRunReport,
  RdMsgHook,
  codeHostHookMetadataOf,
  codeHostHookRevisionOf,
  codeHostHookRuleOf,
  pickCodeHostHookMembers,
  isCodeHostHookKind,
  isCodeHostProvider
} from '../index.js'

const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const REPOSITORY_ID = '00000000-0000-4000-8000-000000000002'
const ROUTING = { organization: 'example-org', projectId: PROJECT_ID, repositoryId: REPOSITORY_ID }
const CREDENTIAL = { provider: 'azure-devops', repoId: '42', connectionId: 'connection-1', azureDevOps: ROUTING }

describe('Azure DevOps as a code-host provider (azure-devops-integration.md §7)', () => {
  it('is a known provider and hook kind, gated by its own feature string', () => {
    expect(CODE_HOST_PROVIDERS).toContain('azure-devops')
    expect(isCodeHostProvider('azure-devops')).toBe(true)
    expect(HOOK_KINDS).toContain('azure-devops')
    expect(isCodeHostHookKind('azure-devops')).toBe(true)
    expect(AZURE_DEVOPS_V1_FEATURE).toBe('azure-devops-v1')
  })

  it('resolves no member for a frame or a compiled rule that carries none', () => {
    expect(codeHostHookMetadataOf({})).toBeUndefined()
    const rule = RcHookAssign.parse({
      hookId: '11111111-1111-4111-8111-111111111111',
      orgId: 'org-1',
      agentId: '22222222-2222-4222-8222-222222222222',
      daemonId: '33333333-3333-4333-8333-333333333333',
      kind: 'azure-devops',
      sessionMode: 'perThread'
    })
    expect(codeHostHookRuleOf(rule)).toBeUndefined()
  })
})

describe('the azure-devops workspace credential arm', () => {
  it('accepts the numeric identity, the connection and the routing', () => {
    expect(AgentWorkspaceCredential.parse(CREDENTIAL)).toEqual(CREDENTIAL)
    const workspace = AgentWorkspace.parse({
      mode: 'git',
      gitRepo: 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo',
      credential: CREDENTIAL
    })
    expect(workspace.mode === 'git' && workspace.credential).toEqual(CREDENTIAL)
  })

  it.each([
    ['a zero id', { ...CREDENTIAL, repoId: '0' }],
    ['a non-decimal id', { ...CREDENTIAL, repoId: '4a' }],
    ['a leading zero', { ...CREDENTIAL, repoId: '042' }],
    ['an empty connection', { ...CREDENTIAL, connectionId: '' }],
    ['no connection', { provider: 'azure-devops', repoId: '42', azureDevOps: ROUTING }],
    ['no routing', { provider: 'azure-devops', repoId: '42', connectionId: 'connection-1' }]
  ])('refuses %s', (_name, value) => {
    expect(AgentWorkspaceCredential.safeParse(value).success).toBe(false)
  })
})

describe('Azure DevOps routing', () => {
  it('validates both GUIDs and lowercases them', () => {
    const upper = { ...ROUTING, projectId: PROJECT_ID.toUpperCase().replace('4000', '4ABC') }
    expect(AzureDevOpsRepoRouting.parse(upper).projectId).toBe('00000000-0000-4abc-8000-000000000001')
  })

  it.each([
    ['a project id that is not a GUID', { ...ROUTING, projectId: 'Example Project' }],
    ['a repository id that is not a GUID', { ...ROUTING, repositoryId: '00000000-0000-4000-8000-00000000000' }],
    ['an organization with a space', { ...ROUTING, organization: 'example org' }],
    ['an organization ending in a hyphen', { ...ROUTING, organization: 'example-' }],
    ['an empty organization', { ...ROUTING, organization: '' }]
  ])('refuses %s', (_name, value) => {
    expect(AzureDevOpsRepoRouting.safeParse(value).success).toBe(false)
  })

  it('rides an additional repository as an optional member, and older entries still decode', () => {
    const entry = {
      repoFullName: 'example-org/Example Project/Example Repo',
      repoId: '42',
      provider: 'azure-devops',
      azureDevOps: ROUTING
    }
    expect(AgentAdditionalRepo.parse(entry).azureDevOps).toEqual(ROUTING)
    expect(AgentAdditionalRepo.parse({ repoFullName: 'example-org/example-repo', repoId: '7' }).azureDevOps).toBe(
      undefined
    )
    expect(AgentAdditionalRepo.safeParse({ ...entry, azureDevOps: { ...ROUTING, repositoryId: 'x' } }).success).toBe(
      false
    )
  })
})

describe('gitcred for Azure DevOps', () => {
  it('names the provider and numeric id on a request, and a grant echoes them', () => {
    const request = GitCredRequest.parse({
      agentId: '22222222-2222-4222-8222-222222222222',
      provider: 'azure-devops',
      externalRepoId: '42',
      requestedAccess: 'read'
    })
    expect(request.provider).toBe('azure-devops')
    const grant = GitCredGrant.parse({
      username: 'example-identity',
      token: 'placeholder-token',
      ttlSec: 600,
      expiresAt: '2026-11-06T01:00:00.000Z',
      repoFullName: 'example-org/Example Project/Example Repo',
      access: 'write',
      provider: 'azure-devops',
      externalRepoId: '42',
      credentialEpoch: '3'
    })
    expect(grant).toMatchObject({
      provider: 'azure-devops',
      externalRepoId: '42',
      access: 'write',
      credentialEpoch: '3'
    })
  })
})

const HOOK_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const DAEMON_ID = '33333333-3333-4333-8333-333333333333'
const SUBSCRIPTION_ID = '00000000-0000-4000-8000-0000000000c1'

const azureRule = {
  repoId: '42',
  repoPath: 'example-org/Example Project/Example Repo',
  sessionKeyPrefix: 'azure-devops:42',
  ...ROUTING,
  instanceId: '00000000-0000-4000-8000-0000000000a0',
  subscriptions: [{ subscriptionId: SUBSCRIPTION_ID, kind: 'comment' as const }],
  events: ['merge_request:opened'],
  commentFamilies: ['pull_request' as const],
  mentionOnly: false,
  identityId: '00000000-0000-4000-8000-0000000000b1',
  signingKey: 'a'.repeat(64)
}
const hookRule = {
  hookId: HOOK_ID,
  kind: 'azure-devops' as const,
  agentId: AGENT_ID,
  daemonId: DAEMON_ID,
  sessionMode: 'perThread' as const,
  azureDevOps: azureRule
}
const metadata = {
  repoId: '42',
  repoPath: 'example-org/Example Project/Example Repo',
  ...ROUTING,
  deliveryKind: 'opened' as const,
  target: { kind: 'pull' as const, pullRequestId: 7, headSha: 'c'.repeat(40) }
}

describe('the compiled azureDevOps rule (azure-devops-integration.md §11.3)', () => {
  it('names its own feature string and fixed Basic user', () => {
    expect(AZURE_DEVOPS_HOOKS_V1_FEATURE).toBe('azure-devops-hooks-v1')
    expect(AZURE_DEVOPS_HOOK_BASIC_USER).toBe('agentconnect')
  })

  it('decodes a rule keyed by subscription id and views it under the surrogate id', () => {
    const upper = { ...azureRule, subscriptions: [{ subscriptionId: SUBSCRIPTION_ID.toUpperCase(), kind: 'comment' }] }
    const parsed = RcHookAssign.parse({ ...hookRule, azureDevOps: upper })
    expect(parsed.azureDevOps?.subscriptions).toEqual([{ subscriptionId: SUBSCRIPTION_ID, kind: 'comment' }])
    expect(codeHostHookRuleOf(parsed)).toEqual({
      provider: 'azure-devops',
      repo: { provider: 'azure-devops', externalId: '42', path: azureRule.repoPath },
      rule: parsed.azureDevOps
    })
  })

  it('carries both rotation keys and the previous key with its expiry', () => {
    const rotating = RcHookAssign.parse({
      ...hookRule,
      azureDevOps: {
        ...azureRule,
        nextSigningKey: 'b'.repeat(64),
        previousSigningKey: 'c'.repeat(64),
        previousSigningKeyExpiresAt: '2026-11-09T00:00:00.000Z'
      }
    })
    expect(rotating.azureDevOps?.nextSigningKey).toBe('b'.repeat(64))
    expect(rotating.azureDevOps?.previousSigningKey).toBe('c'.repeat(64))
  })

  it.each([
    ['a previous key without its expiry', { previousSigningKey: 'c'.repeat(64) }],
    ['an expiry without a previous key', { previousSigningKeyExpiresAt: '2026-11-09T00:00:00.000Z' }],
    ['no subscription', { subscriptions: [] }],
    [
      'one subscription recorded twice',
      {
        subscriptions: [
          { subscriptionId: SUBSCRIPTION_ID, kind: 'comment' },
          { subscriptionId: SUBSCRIPTION_ID, kind: 'opened' }
        ]
      }
    ],
    ['an unknown kind', { subscriptions: [{ subscriptionId: SUBSCRIPTION_ID, kind: 'labeled' }] }],
    ['a subscription id that is not a GUID', { subscriptions: [{ subscriptionId: 'sub-1', kind: 'comment' }] }],
    ['an identity that is not a GUID', { identityId: 'example-identity' }],
    ['a non-decimal surrogate id', { repoId: 'example-org/example-repo' }],
    ['an issue comment family', { commentFamilies: ['issues'] }],
    ['an empty signing key', { signingKey: '' }]
  ])('refuses %s', (_name, change) => {
    expect(RcHookAssign.safeParse({ ...hookRule, azureDevOps: { ...azureRule, ...change } }).success).toBe(false)
  })
})

describe('the azureDevOps frame member (azure-devops-integration.md §11.9)', () => {
  it('views the member under the surrogate id and reads an opened head', () => {
    const view = codeHostHookMetadataOf({ azureDevOps: metadata })
    expect(view).toEqual({
      provider: 'azure-devops',
      repo: { provider: 'azure-devops', externalId: '42', path: metadata.repoPath },
      metadata
    })
    expect(codeHostHookRevisionOf(view!)).toEqual({ headSha: 'c'.repeat(40) })
    const push = {
      ...metadata,
      deliveryKind: 'push' as const,
      target: { kind: 'push' as const, ref: 'refs/heads/main' }
    }
    expect(codeHostHookRevisionOf(codeHostHookMetadataOf({ azureDevOps: push })!)).toBeUndefined()
    expect(pickCodeHostHookMembers({ azureDevOps: metadata })).toEqual({ azureDevOps: metadata })
  })

  it('is exclusive with every other provider member', () => {
    const gitea = { repoId: '7', repoPath: 'example-org/example-repo', target: { kind: 'pull' as const, index: 7 } }
    expect(codeHostHookMetadataOf({ azureDevOps: metadata, gitea })).toBeUndefined()
    const start = {
      hookId: HOOK_ID,
      agentId: AGENT_ID,
      deliveryKey: 'event-1',
      configRevision: '1',
      dispatchRevision: '1',
      dispatchDaemonId: DAEMON_ID,
      reviewPolicy: 'off',
      reportingMode: 'off',
      gateMode: 'informational'
    }
    expect(HookStart.safeParse({ ...start, azureDevOps: metadata }).success).toBe(true)
    expect(HookStart.safeParse({ ...start, azureDevOps: metadata, gitea }).success).toBe(false)
    const report = { hookId: HOOK_ID, agentId: AGENT_ID, deliveryKey: 'event-1', status: 'success' }
    expect(HookReport.safeParse({ ...report, azureDevOps: metadata }).success).toBe(true)
    expect(HookReport.safeParse({ ...report, azureDevOps: metadata, gitea }).success).toBe(false)
  })

  it('rides the relay frames and keeps comment and thread ids as decimals', () => {
    const comment = {
      ...metadata,
      deliveryKind: 'comment' as const,
      target: { kind: 'pull' as const, pullRequestId: 7 },
      threadId: '12',
      commentId: '3'
    }
    const msg = RdMsgHook.parse({
      source: 'hook',
      agentId: AGENT_ID,
      sessionKey: 'azure-devops:42:pull:7',
      msgId: `${HOOK_ID}:event-1`,
      hookId: HOOK_ID,
      deliveryKey: 'event-1',
      firedAt: '2026-11-07T00:00:00.000Z',
      event: 'note:created',
      azureDevOps: comment,
      context: { source: 'azure-devops', event: 'note', action: 'created', number: 7 }
    })
    expect(msg.azureDevOps?.threadId).toBe('12')
    expect(
      RcRunReport.safeParse({
        hookId: HOOK_ID,
        deliveryKey: 'event-1',
        firedAt: '2026-11-07T00:00:00.000Z',
        agentId: AGENT_ID,
        azureDevOps: comment,
        status: 'accepted'
      }).success
    ).toBe(true)
    expect(AzureDevOpsHookMetadata.safeParse({ ...comment, threadId: 'thread-12' }).success).toBe(false)
    expect(AzureDevOpsHookMetadata.safeParse({ ...metadata, target: { kind: 'issue', index: 7 } }).success).toBe(false)
    expect(AzureDevOpsHookMetadata.safeParse({ ...metadata, deliveryKind: 'labeled' }).success).toBe(false)
  })
})

describe('Azure DevOps on the relay-to-CP wire', () => {
  const authz = {
    hookId: HOOK_ID,
    provider: 'azure-devops',
    repoExternalId: '42',
    configRevision: '1',
    dispatchRevision: '1'
  }

  it('names an Azure DevOps actor by identity id instead of a numeric id', () => {
    const parsed = RcCodeHostMembershipAuthz.parse({ ...authz, actorIdentityId: azureRule.identityId.toUpperCase() })
    expect(parsed.actorIdentityId).toBe(azureRule.identityId)
    expect(RcCodeHostMembershipAuthz.safeParse({ ...authz, provider: 'gitea', actorExternalId: '7' }).success).toBe(
      true
    )
  })

  it('requires exactly one actor form', () => {
    expect(RcCodeHostMembershipAuthz.safeParse(authz).success).toBe(false)
    expect(
      RcCodeHostMembershipAuthz.safeParse({ ...authz, actorExternalId: '7', actorIdentityId: azureRule.identityId })
        .success
    ).toBe(false)
    expect(RcCodeHostMembershipAuthz.safeParse({ ...authz, actorIdentityId: 'example-identity' }).success).toBe(false)
  })

  it('reports a delivery verified under the previous key', () => {
    const observed = {
      provider: 'azure-devops',
      repoExternalId: '42',
      deliveryKey: '00000000-0000-4000-8000-0000000000e1',
      receivedAt: '2026-11-07T00:00:00.000Z'
    }
    expect(RcCodeHostDelivery.parse({ ...observed, verifiedWith: 'previous' }).verifiedWith).toBe('previous')
    expect(RcCodeHostDelivery.safeParse({ ...observed, verifiedWith: 'older' }).success).toBe(false)
  })
})
