// Azure DevOps's daemon seams (azure-devops-integration.md §4–§6, §11): a credential only the proxy and the daemon's own Git present, and no hooks in v1.
import { describe, expect, it, vi } from 'vitest'
import { type RdMsgHook } from '@agentconnect.md/protocol'
import { codeHostCredentials, isProxyOnlyProvider, managedHostTable } from '../src/codehost/credentials.js'
import { hookAdmissionFor } from '../src/codehost/hook-admission.js'
import { codeHostHostFence, codeHostReplyTarget, type CodeHostTurnFinalHost } from '../src/codehost/turn-final.js'
import { codeHostRepository } from '../src/codehost/repository.js'
import { matchManagedHost } from '../src/gitcred/managed-hosts.js'
import { credentialRepoPathParser } from '../src/gitcred/repo-path.js'
import { AZURE_DEVOPS_ROOTS_DIR, RESERVED_SECONDARY_ROOT_DIRS } from '../src/workspace/secondary-layout.js'

const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function fire(source: 'azure-devops' | 'webhook'): RdMsgHook {
  return {
    source: 'hook',
    agentId: AGENT,
    sessionKey: `${HOOK}:msg_delivery_1`,
    msgId: `${HOOK}:msg_delivery_1`,
    hookId: HOOK,
    deliveryKey: 'msg_delivery_1',
    firedAt: '2026-11-06T00:00:00.000Z',
    context: { source, truncated: false }
  }
}

function turnFinalHost() {
  const warn = vi.fn()
  const host = { gitlabHostFor: () => undefined, giteaHostFor: () => undefined, log: { warn } }
  return { host: host as unknown as CodeHostTurnFinalHost, warn }
}

describe('the credential seam', () => {
  const module = codeHostCredentials('azure-devops')!

  it('is presented only by the proxy and the daemon’s own Git, and is the only provider that is', () => {
    expect(module.proxyOnly).toBe(true)
    expect(['github', 'gitlab', 'gitea'].map(isProxyOnlyProvider)).toEqual([false, false, false])
    expect(isProxyOnlyProvider('azure-devops')).toBe(true)
    expect(module.liveCredentialPurposes).toEqual([])
    expect(module.workspaceRepoId({ azureDevOpsRepoId: '42', giteaRepoId: '7' })).toBe('42')
  })

  it('reads git’s credential path on the fixed host, which git hands over already percent-decoded', () => {
    expect(module.hostFromSpec).toBe(false)
    expect(module.managedHost({})).toEqual({ provider: 'azure-devops', baseUrl: 'https://dev.azure.com' })
    const match = matchManagedHost(managedHostTable({}), {
      protocol: 'https',
      host: 'dev.azure.com',
      path: 'example-org/Example Project/_git/Example Repo'
    })
    expect(match?.entry.provider).toBe('azure-devops')
    expect(credentialRepoPathParser('azure-devops')).toBe(module.credentialRepoPath)
    const path = module.credentialRepoPath
    expect(path(match!.path!)).toBe('example-org/example project/example repo')
    expect(path('example-org/Example Project/_git/Example Repo.git/info/lfs')).toBe(
      'example-org/example project/example repo'
    )
    // The project-less form names the project like its repository.
    expect(path('/example-org/_git/Example Repo')).toBe('example-org/example repo/example repo')
    expect(path('Example-Org/Example Project/_GIT/Example Repo')).toBe('example-org/example project/example repo')
    // Never decoded twice: a literal `%20` in a name stays one.
    expect(path('example-org/Example%20Project/_git/Example Repo')).toBe('example-org/example%20project/example repo')
    for (const refused of [
      'example-org/Example Project/Example Repo',
      'example-org/a/b/_git/Example Repo',
      'example_org/Example Project/_git/Example Repo',
      'example-org/../_git/Example Repo',
      'example-org/Example Project/_git/',
      'example-org/Example Project/_git/.git'
    ]) {
      expect(path(refused)).toBeUndefined()
    }
  })

  it('places an additional repository by its surrogate id, and clones it at its canonical address', () => {
    expect(
      module.placeSecondaryRoot({ repoFullName: 'example-org/Example Project/Example Repo', repoId: '42' })
    ).toEqual({
      provider: 'azure-devops',
      repoFullName: 'example-org/Example Project/Example Repo',
      subtreeName: '_azure-devops/42'
    })
    for (const row of [
      { repoFullName: 'example-org/Example Project/Example Repo', repoId: '0' },
      { repoFullName: 'example-org/Example Project/Example Repo', repoId: 'abc' },
      { repoFullName: 'example-org/Example Repo', repoId: '42' },
      { repoFullName: 'example-org/Example Project/..', repoId: '42' },
      { repoFullName: 'example_org/Example Project/Example Repo', repoId: '42' }
    ]) {
      expect(module.placeSecondaryRoot(row)).toBeUndefined()
    }
    expect(module.secondaryCloneUrl('example-org/Example Project/Example Repo', {})).toBe(
      'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo'
    )
    expect(() => module.secondaryCloneUrl('example-org/Example Repo', {})).toThrow(/does not name/)
    expect(module.secondaryCredentialScope({})).toEqual({
      host: { provider: 'azure-devops', baseUrl: 'https://dev.azure.com' }
    })
    const canonical = 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo'
    expect(module.canonicalCloneUrl(canonical)).toBe(canonical)
    expect(module.managedRemoteUrl(canonical)).toBe(canonical)
    expect(codeHostRepository('azure-devops')).toBeUndefined()
  })

  it('reserves its secondary-root directory, so no GitHub row can land there', () => {
    expect(AZURE_DEVOPS_ROOTS_DIR).toBe('_azure-devops')
    expect(RESERVED_SECONDARY_ROOT_DIRS.has(AZURE_DEVOPS_ROOTS_DIR)).toBe(true)
    expect(codeHostCredentials('github')!.placeSecondaryRoot({ repoFullName: '_azure-devops/42', repoId: '1' })).toBe(
      undefined
    )
  })
})

describe('hooks (no Azure DevOps hooks in v1)', () => {
  it('refuses a delivery whose envelope names Azure DevOps before a turn starts, and opens no reply target', () => {
    const { host, warn } = turnFinalHost()
    expect(codeHostHostFence(fire('azure-devops'), host)).toBe('code_host_not_implemented')
    expect(warn).toHaveBeenCalledOnce()
    expect(codeHostReplyTarget(fire('azure-devops'))).toBeUndefined()
    expect(codeHostHostFence(fire('webhook'), host)).toBeUndefined()
  })

  it('admits nothing: no trusted member can name the provider', () => {
    expect(hookAdmissionFor({ hookId: HOOK, agentId: AGENT })).toBeUndefined()
  })
})
