import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import {
  clusterWorkspaceCwd,
  prepareClusterWorkspace,
  setWorkspaceGitRunnerResolver,
  setWorkspacePathClearer
} from '../src/workspace/workspace-manager.js'
import {
  daemonGitCredentialTarget,
  initGitInjection,
  sandboxGitCredentialTarget
} from '../src/workspace/git-injection.js'
import { SANDBOX_CHECKOUT_DIR } from '../src/shim/sandbox-paths.js'
import type { GitRunner } from '../src/workspace/git-runner.js'
import type { Agent } from '../src/agents/agent-schema.js'

/**
 * Preparing a git-repo workspace for a CLUSTER agent, which `--k8s` refused outright until now.
 *
 * Every assertion here is about coordinates. The checkout lives on the pod's volume, so the
 * questions the local path answers with `existsSync` and `mkdirSync` have to be asked of the POD
 * instead — and the failure mode when they are not is silent: the daemon inspects its own empty
 * directory, concludes there is no checkout, and clones on every session while the runtime sees a
 * workspace nobody prepared.
 *
 * The runner is a recording stand-in for the shim's exec channel, because what is under test is
 * WHICH git the daemon asks for and where, not git itself.
 */

const POD_ROOT = '/agent'
const CHECKOUT = `${POD_ROOT}/${SANDBOX_CHECKOUT_DIR}`

interface Invocation {
  cwd: string | undefined
  args: string[]
  env: Record<string, string>
}

let calls: Invocation[] = []
let cleared: string[] = []
/** Answers the `rev-parse --git-dir` probe; false ⇒ the pod holds no usable checkout. */
let checkoutExists = false
let cloneFails = false
/** What the pod's checkout reports as its origin — a resumed volume carries the previous launch's. */
let originUrl = 'https://github.com/acme/private.git'

function recordingRunner(cwd: string | undefined, env: Record<string, string> = {}): GitRunner {
  const run = async (args: string[]): Promise<string> => {
    calls.push({ cwd, args, env })
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
      if (!checkoutExists) throw new Error('cwd does not resolve: no checkout in the pod')
      return '.git'
    }
    if (args[0] === 'remote' && args[1] === 'get-url') return originUrl
    return ''
  }
  const runner: GitRunner = {
    withEnv: (next) => recordingRunner(cwd, next),
    raw: run,
    clone: async (repo, target, options = []) => {
      calls.push({ cwd, args: ['clone', repo, target, ...options], env })
      if (cloneFails) throw new Error('remote hung up')
    },
    pull: async (remote, branch, options = []) => {
      calls.push({ cwd, args: ['pull', remote, branch, ...options], env })
      return { files: [], insertions: 0, deletions: 0 }
    },
    status: async () => ({ current: 'main', tracking: null, ahead: 0, behind: 0, files: [], clean: true }),
    log: async () => [],
    readBounded: async () => ({ out: Buffer.alloc(0), overflow: false })
  }
  return runner
}

function clusterAgent(overrides: Partial<Agent['workspace']> = {}, id = 'agent-cluster'): Agent {
  return {
    id,
    name: id,
    runtime: 'claude-acp',
    dir: `/daemon/agents/${id}`,
    mcpServers: [],
    managedSkills: [],
    workspace: {
      mode: 'git-repo',
      // The DAEMON's bookkeeping path, which must never be used as a pod coordinate.
      path: `/daemon/agents/${id}/workspace`,
      gitRepo: 'https://github.com/acme/private.git',
      gitBranch: 'main',
      gitCredential: 'github-app',
      pullOnNewSession: true,
      skills: [],
      ...overrides
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent
}

beforeEach(() => {
  calls = []
  cleared = []
  checkoutExists = false
  cloneFails = false
  originUrl = 'https://github.com/acme/private.git'
  // Every agent here runs in a pod, so both seams resolve to the sandbox.
  setWorkspaceGitRunnerResolver((_agentId, cwd) => recordingRunner(cwd))
  setWorkspacePathClearer(async (_agentId, root) => {
    cleared.push(root)
    return undefined
  })
  initGitInjection({
    targetFor: (agentId) =>
      agentId.startsWith('local-')
        ? daemonGitCredentialTarget({ shimPath: '/daemon/run/helper.sh', runDir: '/daemon/run' })
        : sandboxGitCredentialTarget(),
    preWarm: async () => undefined,
    capabilityFor: (agentId) => `cap-${agentId}`
  })
})

afterEach(() => {
  setWorkspaceGitRunnerResolver(undefined)
  setWorkspacePathClearer(undefined)
})

describe('clusterWorkspaceCwd', () => {
  it('puts a checkout one level below the mount, away from the runtime HOME', () => {
    // The mount is also HOME=/agent: a working tree at the root would sit on top of `.claude` and
    // `.codex`, where git reports them as untracked and `git clean` would delete them.
    expect(clusterWorkspaceCwd(clusterAgent(), POD_ROOT)).toBe(CHECKOUT)
    // A from-scratch workspace keeps the root — it has no tree to confuse with HOME, and moving it
    // would strand every volume already provisioned.
    expect(clusterWorkspaceCwd(clusterAgent({ mode: 'from-scratch' }), POD_ROOT)).toBe(POD_ROOT)
  })

  it('applies the configured working subdirectory inside the pod', () => {
    expect(clusterWorkspaceCwd(clusterAgent({ agentDir: 'services/api' }), POD_ROOT)).toBe(`${CHECKOUT}/services/api`)
  })

  it('still refuses session isolation rather than half-supporting it', () => {
    // A logical-session worktree needs a daemon-owned parent, `worktree add` in the sandbox, and a
    // retention GC that reads the pod's tree — none of which this change provides.
    expect(() => clusterWorkspaceCwd(clusterAgent(), POD_ROOT, { isolation: 'session' })).toThrow(
      /session-isolated workspaces are not supported/
    )
  })
})

describe('preparing a cluster git-repo workspace', () => {
  it('asks the POD whether a checkout exists, and clones inside its fence when it does not', async () => {
    const cwd = await prepareClusterWorkspace(clusterAgent(), POD_ROOT)
    expect(cwd).toBe(CHECKOUT)

    // The existence question went to the pod as git, not to this daemon as a file test.
    expect(calls[0]).toMatchObject({ cwd: CHECKOUT, args: ['rev-parse', '--git-dir'] })

    // And the clone target is RELATIVE to a cwd the shim fences: an absolute target would be argv
    // the fence never inspects, so it could land anywhere on the volume.
    const clone = calls.find((call) => call.args[0] === 'clone')
    expect(clone).toMatchObject({
      cwd: POD_ROOT,
      args: [
        'clone',
        'https://github.com/acme/private.git',
        SANDBOX_CHECKOUT_DIR,
        '--branch',
        'main',
        '--single-branch'
      ]
    })
    // Nothing was created on the daemon's own disk — the whole point of the split.
    expect(existsSync(POD_ROOT)).toBe(false)
  })

  it('pins the repo-local helper in the pod after cloning', async () => {
    await prepareClusterWorkspace(clusterAgent(), POD_ROOT)
    // `.git/config` outlives the launch, so the helper a later agent-run git finds has to be the
    // image's path — written through the runner, in the checkout.
    const helper = calls.filter((call) => call.args[0] === 'config' && call.args.includes('--add'))
    expect(helper).toHaveLength(1)
    expect(helper[0]).toMatchObject({ cwd: CHECKOUT })
    expect(helper[0]!.args.at(-1)).toContain('/opt/agentconnect/bin/git-credential')
  })

  it('pulls an existing checkout instead of cloning over it', async () => {
    checkoutExists = true
    await prepareClusterWorkspace(clusterAgent(), POD_ROOT)

    expect(calls.some((call) => call.args[0] === 'clone')).toBe(false)
    const pull = calls.find((call) => call.args[0] === 'pull')
    expect(pull).toMatchObject({ cwd: CHECKOUT })
    // The pull carries the credential pair, or a private repo's fetch has nothing to authenticate with.
    expect(pull!.env).toMatchObject({ AC_GITCRED_AGENT: 'agent-cluster' })
    // And the audit ran against the POD's config, not a directory on this disk.
    expect(calls.some((call) => call.cwd === CHECKOUT && call.args.includes('--includes'))).toBe(true)
  })

  it('follows a repository rename on a resumed volume, in the pod', async () => {
    // The CP tracks a repository by numeric id, so a rename shows up as a new canonical URL. A
    // resumed volume still points at the old one, and repointing it is what keeps that from being
    // treated as a different workspace.
    checkoutExists = true
    originUrl = 'https://github.com/acme/old-name.git'
    await prepareClusterWorkspace(clusterAgent(), POD_ROOT)
    const setUrl = calls.find((call) => call.args[0] === 'remote' && call.args[1] === 'set-url')
    expect(setUrl).toMatchObject({
      cwd: CHECKOUT,
      args: ['remote', 'set-url', 'origin', 'https://github.com/acme/private.git']
    })
  })

  it('refuses a checkout on the volume whose origin is not a trusted GitHub remote', async () => {
    // Fail-closed, exactly as the local path is: a volume that survived from somewhere else must not
    // have daemon-managed git run against whatever origin it carries.
    checkoutExists = true
    originUrl = 'https://evil.example/acme/private.git'
    await expect(prepareClusterWorkspace(clusterAgent(), POD_ROOT)).rejects.toThrow(/not a trusted GitHub remote/)
    expect(calls.some((call) => call.args[0] === 'pull')).toBe(false)
  })

  it('empties a partial checkout in the pod when a clone fails, then reports the failure', async () => {
    // Left behind, git would refuse to clone into a non-empty directory forever after, while the
    // probe kept saying there is no usable checkout. There is no `rmSync` that can reach it.
    cloneFails = true
    await expect(prepareClusterWorkspace(clusterAgent(), POD_ROOT)).rejects.toThrow(/remote hung up/)
    expect(cleared).toEqual([CHECKOUT])
  })

  it('does no git at all for a from-scratch cluster workspace', async () => {
    const cwd = await prepareClusterWorkspace(clusterAgent({ mode: 'from-scratch' }), POD_ROOT)
    expect(cwd).toBe(POD_ROOT)
    expect(calls).toEqual([])
  })

  it('falls back to the historical mount when a legacy shim reported none', async () => {
    const cwd = await prepareClusterWorkspace(clusterAgent(), undefined)
    expect(cwd).toBe(CHECKOUT)
  })
})
