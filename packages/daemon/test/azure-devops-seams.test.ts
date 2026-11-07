// Azure DevOps before its daemon step (azure-devops-integration.md §13): known to every seam, served by none.
import { describe, expect, it, vi } from 'vitest'
import { type RdMsgHook } from '@agentconnect.md/protocol'
import { codeHostCredentials, managedHostTable } from '../src/codehost/credentials.js'
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

  it('knows the fixed host but serves no credential path, so the helper stays silent there', () => {
    expect(module.hostFromSpec).toBe(false)
    expect(module.managedHost({})).toEqual({ provider: 'azure-devops', baseUrl: 'https://dev.azure.com' })
    const match = matchManagedHost(managedHostTable({}), {
      protocol: 'https',
      host: 'dev.azure.com',
      path: 'example-org/Example%20Project/_git/Example%20Repo'
    })
    expect(match?.entry.provider).toBe('azure-devops')
    expect(credentialRepoPathParser('azure-devops')).toBeUndefined()
    expect(module.credentialRepoPath('example-org/Example%20Project/_git/Example%20Repo')).toBeUndefined()
    expect(module.liveCredentialPurposes).toEqual([])
  })

  it('declines every additional repository and refuses to name a clone address for one', () => {
    expect(module.placeSecondaryRoot({ repoFullName: 'example-org/Example Project/Example Repo', repoId: '42' })).toBe(
      undefined
    )
    expect(() => module.secondaryCloneUrl('example-org/Example Project/Example Repo', {})).toThrow(
      /^code_host_not_implemented: azure-devops/
    )
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
