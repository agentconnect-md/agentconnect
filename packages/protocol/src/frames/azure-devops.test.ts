import { describe, expect, it } from 'vitest'
import {
  AZURE_DEVOPS_V1_FEATURE,
  AgentAdditionalRepo,
  AgentWorkspace,
  AgentWorkspaceCredential,
  AzureDevOpsRepoRouting,
  CODE_HOST_PROVIDERS,
  GitCredGrant,
  GitCredRequest,
  HOOK_KINDS,
  RcHookAssign,
  codeHostHookMetadataOf,
  codeHostHookRuleOf,
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

  it('carries no hook member, so no frame or compiled rule resolves to it', () => {
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
