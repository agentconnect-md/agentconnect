// Azure DevOps's daemon seams (azure-devops-integration.md §4–§6, §11): a credential only the proxy and the daemon's own Git present.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RdMsgHook } from '@agentconnect.md/protocol'
import {
  codeHostCredentials,
  isProxyOnlyProvider,
  managedHostTable,
  proxyOnlyProvidersOf
} from '../src/codehost/credentials.js'
import {
  CLI_STATE_DIR,
  codeHostCliEnv,
  codeHostCliLaunch,
  codeHostCliReads,
  reclaimCliStateDirs
} from '../src/credential-proxy/cli-env.js'
import { proxyOnlyHostRefusal, type ProxyOnlyReach } from '../src/credential-proxy/proxy-only.js'
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

  it('is presented only by the proxy and the daemon’s own Git, as GitLab and Gitea are and GitHub is not', () => {
    expect(module.proxyOnly).toBe(true)
    expect(['github', 'gitlab', 'gitea'].map(isProxyOnlyProvider)).toEqual([false, true, true])
    expect(isProxyOnlyProvider('azure-devops')).toBe(true)
    expect(module.liveCredentialPurposes).toEqual(['azure_devops_hook_reply'])
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

describe('hooks without a trusted member', () => {
  it('fences no instance and opens no reply target for an envelope alone', () => {
    const { host, warn } = turnFinalHost()
    expect(codeHostHostFence(fire('azure-devops'), host)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    expect(codeHostReplyTarget(fire('azure-devops'))).toBeUndefined()
    expect(codeHostHostFence(fire('webhook'), host)).toBeUndefined()
  })

  it('admits nothing without the trusted member', () => {
    expect(hookAdmissionFor({ hookId: HOOK, agentId: AGENT })).toBeUndefined()
  })
})

describe('where a host of an agent with Azure DevOps repositories may start', () => {
  const reached: ProxyOnlyReach = {
    proxyRunning: true,
    managedCredential: true,
    served: () => true
  }
  const REFUSAL =
    /^azure_devops_requires_proxy: Azure DevOps repositories are reached only through this daemon's credential proxy, and /

  it('names the agent’s proxy-only providers from its workspace credential and its additional repositories', () => {
    const row = (provider?: string) => ({ ...(provider ? { provider } : {}) })
    expect(proxyOnlyProvidersOf({ gitCredential: 'azure-devops' })).toEqual(['azure-devops'])
    expect(
      proxyOnlyProvidersOf({
        gitCredential: 'github-app',
        additionalRepos: [row(), row('azure-devops'), row('gitlab')]
      })
    ).toEqual(['azure-devops', 'gitlab'])
    expect(proxyOnlyProvidersOf({ gitCredential: 'gitlab', additionalRepos: [row('gitea'), row()] })).toEqual([
      'gitlab',
      'gitea'
    ])
    expect(proxyOnlyProvidersOf({ gitCredential: 'github-app', additionalRepos: [row()] })).toEqual([])
  })

  it('admits served credentials before each execution environment checks its current route', () => {
    expect(proxyOnlyHostRefusal(['azure-devops'], reached)).toBeUndefined()
    const refusals = [
      [{ proxyRunning: false }, 'the credential proxy is not running on this daemon'],
      [{ managedCredential: false }, 'the agent holds no managed code-host credential'],
      [{ served: () => false }, 'the proxy serves none of those repositories, whose routing the spec does not carry']
    ] as const
    for (const [unreached, reason] of refusals) {
      const refusal = proxyOnlyHostRefusal(['azure-devops'], { ...reached, ...unreached })
      expect(refusal).toMatch(REFUSAL)
      expect(refusal?.endsWith(reason)).toBe(true)
    }
    // An agent with no proxy-only repositories starts wherever it did, a proxy or none.
    expect(proxyOnlyHostRefusal([], { ...reached, proxyRunning: false })).toBeUndefined()
  })
})

describe('the Azure CLI in a proxied session', () => {
  const PLACEHOLDER = 'acph1_example.tag'
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ac-azure-cli-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function cliEnv(overrides: Partial<Parameters<typeof codeHostCliEnv>[0]> = {}) {
    return codeHostCliEnv({
      providers: ['github', 'azure-devops', 'azure-devops'],
      placeholder: PLACEHOLDER,
      home: join(root, 'home'),
      hostKey: AGENT,
      config: { azureDevOps: { cliExtensionDir: join(root, 'cliextensions') } },
      own: () => false,
      ...overrides
    })
  }

  it('presents the placeholder from a fresh, empty state directory of the host’s own, and loads extensions only where they exist', () => {
    const first = cliEnv()
    expect(first).toEqual({
      AZURE_DEVOPS_EXT_PAT: PLACEHOLDER,
      AZURE_CONFIG_DIR: expect.stringContaining(join(root, 'home', CLI_STATE_DIR)),
      AZURE_EXTENSION_DIR: expect.stringContaining(join(root, 'home', CLI_STATE_DIR)),
      AZURE_CORE_COLLECT_TELEMETRY: 'false'
    })
    expect(first.AZURE_EXTENSION_DIR).toBe(`${first.AZURE_CONFIG_DIR}/cliextensions`)
    // A sign-in the last start left is gone on the next.
    writeFileSync(join(first.AZURE_CONFIG_DIR!, 'azureProfile.json'), '{}')
    mkdirSync(join(root, 'cliextensions'))
    const second = cliEnv()
    expect(second.AZURE_CONFIG_DIR).toBe(first.AZURE_CONFIG_DIR)
    expect(readdirSync(second.AZURE_CONFIG_DIR!)).toEqual([])
    expect(second.AZURE_EXTENSION_DIR).toBe(join(root, 'cliextensions'))
    // Another host of the agent keeps its own.
    expect(cliEnv({ hostKey: `${AGENT}\u0000session-1` }).AZURE_CONFIG_DIR).not.toBe(first.AZURE_CONFIG_DIR)
    // A variable the session's own env sets is left to it, and a provider with no CLI adds nothing.
    expect(cliEnv({ own: (name) => name === 'AZURE_DEVOPS_EXT_PAT' })).not.toHaveProperty('AZURE_DEVOPS_EXT_PAT')
    expect(cliEnv({ providers: ['github', 'gitlab', 'gitea'] })).toEqual({})
  })

  // POSIX only: the planted link is a symbolic link.
  it.skipIf(process.platform === 'win32')('refuses a link planted where the state directories are kept', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    mkdirSync(join(root, 'home'))
    symlinkSync(outside, join(root, 'home', CLI_STATE_DIR))
    expect(() => cliEnv()).toThrow(/is not a real directory/)
    expect(readdirSync(outside)).toEqual([])
    // At boot the link itself is reclaimed, never what it points at.
    writeFileSync(join(outside, 'kept'), '')
    reclaimCliStateDirs(join(root, 'home'))
    expect(existsSync(join(root, 'home', CLI_STATE_DIR))).toBe(false)
    expect(readdirSync(outside)).toEqual(['kept'])
  })

  it('defaults the extensions to the daemon user’s, and has an OS sandbox read the CLI and the extensions that exist', () => {
    expect(codeHostCredentials('azure-devops')!.cli!.extensionDir({})).toBe(join(homedir(), '.azure', 'cliextensions'))
    const missing = { azureDevOps: { cliExtensionDir: join(root, 'missing') } }
    expect(codeHostCliReads(['azure-devops'], missing)).toEqual({ commands: ['az'], paths: [] })
    expect(codeHostCliReads(['github', 'azure-devops'], { azureDevOps: { cliExtensionDir: root } })).toEqual({
      commands: ['az'],
      paths: [root]
    })
    expect(codeHostCliReads(['github', 'gitlab', 'gitea'], {})).toEqual({ commands: [], paths: [] })
  })

  it('plans remote CLI state in the target filesystem without reading or creating holder paths', () => {
    const opts = {
      providers: ['github', 'azure-devops', 'azure-devops'],
      placeholder: PLACEHOLDER,
      root: '/run/agentconnect',
      hostKey: AGENT,
      own: () => false
    }
    const planned = codeHostCliLaunch(opts)
    expect(planned.env).toEqual({
      AZURE_DEVOPS_EXT_PAT: PLACEHOLDER,
      AZURE_CONFIG_DIR: expect.stringMatching(/^\/run\/agentconnect\/\.agentconnect-cli\/azure-devops-/),
      AZURE_EXTENSION_DIR: expect.stringMatching(
        /^\/run\/agentconnect\/\.agentconnect-cli\/azure-devops-.*\/cliextensions$/
      ),
      AZURE_CORE_COLLECT_TELEMETRY: 'false'
    })
    expect(planned.env.AZURE_EXTENSION_DIR).toBe(`${planned.env.AZURE_CONFIG_DIR}/cliextensions`)
    expect(planned.clearDirs).toEqual([planned.env.AZURE_CONFIG_DIR])
    expect(codeHostCliLaunch({ ...opts, providers: ['github'] })).toEqual({ env: {}, clearDirs: [] })
    expect(codeHostCliLaunch({ ...opts, hostKey: `${AGENT}\u0000session-1` }).clearDirs).not.toEqual(planned.clearDirs)
    const supplied = codeHostCliLaunch({
      ...opts,
      own: (name) => name === 'AZURE_DEVOPS_EXT_PAT' || name === 'AZURE_EXTENSION_DIR'
    })
    expect(supplied.env).not.toHaveProperty('AZURE_EXTENSION_DIR')
    expect(supplied.env).not.toHaveProperty('AZURE_DEVOPS_EXT_PAT')
  })
})
