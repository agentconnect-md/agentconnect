import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  additionalWorkspaceDirectories,
  clusterWorkspaceCwd,
  prepareClusterWorkspace,
  prepareWorkspaceForActivation,
  setSandboxWorkspaceMode,
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
/** The branch the pod's checkout is ON. `pull` does not switch branches, so this can differ from
 *  the configured one — which is exactly the case a marker must not paper over. */
let headBranch = 'main'
let pullFails = false
/** The pod refusing to empty a path — a conversion that proceeded anyway would serve the old tree. */
let clearFails = false

function recordingRunner(cwd: string | undefined, env: Record<string, string> = {}): GitRunner {
  const run = async (args: string[]): Promise<string> => {
    calls.push({ cwd, args, env })
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
      if (!checkoutExists) throw new Error('cwd does not resolve: no checkout in the pod')
      return '.git'
    }
    if (args[0] === 'remote' && args[1] === 'get-url') return originUrl
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return headBranch
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
      // What git does on divergent history with --ff-only: refuses, leaving the branch as it was.
      if (pullFails) throw new Error('Not possible to fast-forward, aborting.')
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
  headBranch = 'main'
  pullFails = false
  clearFails = false
  // Every agent here runs in a pod, so both seams resolve to the sandbox.
  setWorkspaceGitRunnerResolver((_agentId, cwd) => recordingRunner(cwd))
  setWorkspacePathClearer(async (_agentId, root) => {
    cleared.push(root)
    // Emptying the checkout is precisely what makes the pod's probe stop finding one.
    if (root === CHECKOUT) checkoutExists = false
    if (clearFails) return 'permission denied'
    return undefined
  })
  setSandboxWorkspaceMode(true)
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
  setSandboxWorkspaceMode(false)
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

  it('names the enclosing checkout in the POD coordinates the cwd is in', () => {
    // The runtime gets the repository root separately so repo-wide tools can reach `.git` and
    // siblings. Deriving it the local way means `realpathSync` on a path that exists on no
    // filesystem this daemon can see — which throws, and takes every cluster session with it.
    const agent = clusterAgent({ agentDir: 'services/api' })
    expect(additionalWorkspaceDirectories(agent, clusterWorkspaceCwd(agent, POD_ROOT))).toEqual([CHECKOUT])
    // No subdirectory means the cwd already IS the root, and a second copy of it says nothing.
    expect(additionalWorkspaceDirectories(clusterAgent(), CHECKOUT)).toEqual([])
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
describe('replacing a cluster workspace in place', () => {
  /** Activation reads and writes its materialization marker beside the daemon-side bookkeeping
   *  path, so these need a real one — it is the only local state this function keeps. */
  function bookkeepingAgent(overrides: Partial<Agent['workspace']> = {}): Agent {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-cluster-act-')), 'workspace')
    return clusterAgent({ path, ...overrides })
  }

  /**
   * Establish a marker the only way a cluster agent legitimately can: a preparation that PROVED the
   * volume. Here that is a fresh clone, whose `--branch` decided HEAD.
   *
   * Activation deliberately does not seed one, so a test that used it to set up would be asserting
   * against a marker no volume ever backed — which is exactly the circularity under test.
   */
  async function withProvenMarker(overrides: Partial<Agent['workspace']> = {}): Promise<Agent> {
    const agent = bookkeepingAgent(overrides)
    checkoutExists = false
    await prepareClusterWorkspace(agent, POD_ROOT)
    calls.length = 0
    return agent
  }

  it('is a no-op for a first activation, leaving the clone to session preparation', async () => {
    // No marker means nothing to replace: the volume either has no checkout, which preparation
    // clones, or has one that convergence fixes. Refusing here would make a git-repo cluster agent
    // impossible to create at all, since `replace` is true whenever there is no previous marker.
    const agent = bookkeepingAgent()
    await expect(prepareWorkspaceForActivation(agent, { reconcileMaterialization: true })).resolves.toBeTypeOf(
      'function'
    )
    expect(calls).toEqual([])
  })

  it('does not seed a marker from the target, which preparation would read back as proof', async () => {
    // The circle this closes: activation recording the TARGET says something about a volume nothing
    // has inspected, and cluster preparation then treats that as attestation of the repository. So an
    // existing unproven volume with a failing pull would be accepted.
    const agent = bookkeepingAgent()
    await prepareWorkspaceForActivation(agent, { reconcileMaterialization: true })

    checkoutExists = true
    pullFails = true
    await prepareClusterWorkspace(agent, POD_ROOT)
    // Still unproven, so a conversion stays detectable rather than being silently accepted.
    const moved = { ...agent, workspace: { ...agent.workspace, gitRepo: 'https://github.com/acme/other.git' } } as Agent
    await expect(prepareWorkspaceForActivation(moved, { reconcileMaterialization: true })).resolves.toBeTypeOf(
      'function'
    )
  })

  it('lets a rollback and a same-workspace repair through, which a blanket refusal stranded', async () => {
    // The sequence that matters: a rejected git→git edit restores the original row and re-activates
    // it with `reconcileWorkspace`. When that restoration was refused too, the agent stayed staged
    // and offline — the failure the refusal was supposed to prevent, made permanent.
    const agent = await withProvenMarker()
    await expect(prepareWorkspaceForActivation(agent, { reconcileMaterialization: true })).resolves.toBeTypeOf(
      'function'
    )
    await expect(prepareWorkspaceForActivation(agent)).resolves.toBeTypeOf('function')
  })

  it('refreshes the marker after preparation, so a rename elsewhere does not strand a repair', async () => {
    // move away → repository renamed while the agent is on another daemon → move back. Ordinary
    // placement activation asks for no reconciliation, so nothing else refreshes this daemon's
    // marker; preparation converges the shared volume to the new URL and has to record that, or a
    // later repair reads the old marker as a CHANGE and refuses an agent whose checkout is correct.
    const agent = await withProvenMarker()
    const renamed = {
      ...agent,
      workspace: { ...agent.workspace, gitRepo: 'https://github.com/acme/renamed.git' }
    } as Agent
    checkoutExists = true
    originUrl = 'https://github.com/acme/private.git'
    await prepareClusterWorkspace(renamed, POD_ROOT)
    expect(calls.some((call) => call.args[0] === 'remote' && call.args[1] === 'set-url')).toBe(true)

    await expect(prepareWorkspaceForActivation(renamed, { reconcileMaterialization: true })).resolves.toBeTypeOf(
      'function'
    )
  })

  it('leaves the marker alone when a divergent branch keeps the volume on the old one', async () => {
    // `pullWorkspaceRef` pulls INTO the current branch rather than switching, so a configured branch
    // that has diverged fails ff-only and the volume stays where it was. Recording the new branch
    // there would tell every later activation that nothing changed, and the agent would run the
    // wrong branch indefinitely — silently, which is what makes it expensive.
    const agent = await withProvenMarker()
    const moved = { ...agent, workspace: { ...agent.workspace, gitBranch: 'release' } } as Agent
    checkoutExists = true
    headBranch = 'main' // the volume never left `main`
    pullFails = true
    await prepareClusterWorkspace(moved, POD_ROOT)

    // Unproven, so the edit's replacement is still due: the next preparation empties the checkout
    // and clones the configured branch rather than serving `main` forever.
    await prepareWorkspaceForActivation(moved, { reconcileMaterialization: true })
    calls.length = 0
    await prepareClusterWorkspace(moved, POD_ROOT)
    expect(cleared).toEqual([CHECKOUT])
    expect(calls.find((call) => call.args[0] === 'clone')?.args).toContain('release')
  })

  it('records the marker once the volume is provably on the configured branch', async () => {
    const agent = await withProvenMarker()
    const moved = { ...agent, workspace: { ...agent.workspace, gitBranch: 'release' } } as Agent
    checkoutExists = true
    headBranch = 'release' // the volume IS on it, and the pull succeeded
    await prepareClusterWorkspace(moved, POD_ROOT)
    await expect(prepareWorkspaceForActivation(moved, { reconcileMaterialization: true })).resolves.toBeTypeOf(
      'function'
    )
  })

  it('will not trust a rewritten origin that no successful pull backs up, on ANY attempt', async () => {
    // A rewritten URL says nothing about the tree that was already there: the branch name can match
    // in both repositories while the content is the old one. Only a pull that succeeded against the
    // new origin shows otherwise — and the proof has to survive a retry, which is what makes it a
    // question about the stored marker rather than about what this call happened to rewrite.
    const agent = await withProvenMarker()
    const renamed = {
      ...agent,
      workspace: { ...agent.workspace, gitRepo: 'https://github.com/acme/renamed.git' }
    } as Agent
    checkoutExists = true
    originUrl = 'https://github.com/acme/private.git' // convergence has to rewrite it
    pullFails = true
    await prepareClusterWorkspace(renamed, POD_ROOT)

    // SECOND attempt: `set-url` persisted, so the origin already matches and nothing is rewritten
    // this time. Keyed off that, the proof would evaporate and the marker would advance over a tree
    // no pull has ever reached.
    originUrl = 'https://github.com/acme/renamed.git'
    await prepareClusterWorkspace(renamed, POD_ROOT)
    // Nothing an EDIT asked for, so the unproven volume is left in place rather than replaced.
    expect(cleared).toEqual([])

    // And once a pull from the new origin does succeed, it is proven and recorded.
    pullFails = false
    await prepareClusterWorkspace(renamed, POD_ROOT)
    await expect(prepareWorkspaceForActivation(renamed, { reconcileMaterialization: true })).resolves.toBeTypeOf(
      'function'
    )
    expect(cleared).toEqual([])
  })

  it('records a conversion of an EXISTING checkout instead of refusing it', async () => {
    // Activation cannot do the replacement itself: it has no atomic swap through the shim and runs
    // before the CP has acknowledged the edit, so anything destructive here would have to survive a
    // rollback that cannot restore it. It records the intent; the pod's preparation carries it out.
    const agent = await withProvenMarker()
    const moved = { ...agent, workspace: { ...agent.workspace, gitRepo: 'https://github.com/acme/other.git' } } as Agent
    await expect(prepareWorkspaceForActivation(moved, { reconcileMaterialization: true })).resolves.toBeTypeOf(
      'function'
    )
    expect(calls).toEqual([])
    expect(cleared).toEqual([])

    checkoutExists = true
    await prepareClusterWorkspace(moved, POD_ROOT)
    // Emptied, then re-cloned from the new repository — the replacement the edit asked for.
    expect(cleared).toEqual([CHECKOUT])
    expect(calls.find((call) => call.args[0] === 'clone')?.args).toContain('https://github.com/acme/other.git')
    // Never converged onto the previous tree, which is what a rewritten origin alone would do.
    expect(calls.some((call) => call.args[1] === 'set-url')).toBe(false)
  })

  it('does not replace the volume twice for one edit', async () => {
    // The marker advances when preparation proves the new workspace, and that — not the intent
    // file — is what ends the conversion. A leftover intent must not re-wipe a converged volume.
    const agent = await withProvenMarker()
    const moved = { ...agent, workspace: { ...agent.workspace, gitRepo: 'https://github.com/acme/other.git' } } as Agent
    await prepareWorkspaceForActivation(moved, { reconcileMaterialization: true })
    checkoutExists = true
    await prepareClusterWorkspace(moved, POD_ROOT)
    checkoutExists = true
    await prepareClusterWorkspace(moved, POD_ROOT)
    expect(cleared).toEqual([CHECKOUT])
  })

  it('takes the intent back when the activation it belongs to fails', async () => {
    // The rollback the daemon runs when the host will not start. The edit never became authoritative,
    // so the volume must not be replaced on some later session as if it had.
    const agent = await withProvenMarker()
    const moved = { ...agent, workspace: { ...agent.workspace, gitRepo: 'https://github.com/acme/other.git' } } as Agent
    const rollback = await prepareWorkspaceForActivation(moved, { reconcileMaterialization: true })
    rollback()

    checkoutExists = true
    await prepareClusterWorkspace(moved, POD_ROOT)
    expect(cleared).toEqual([])
  })

  it('fails closed when the pod will not empty the checkout', async () => {
    // Proceeding would clone into a non-empty directory — or, worse, converge the new origin onto
    // the previous repository's tree and serve it as the new workspace.
    const agent = await withProvenMarker()
    const moved = { ...agent, workspace: { ...agent.workspace, gitRepo: 'https://github.com/acme/other.git' } } as Agent
    await prepareWorkspaceForActivation(moved, { reconcileMaterialization: true })
    checkoutExists = true
    clearFails = true
    await expect(prepareClusterWorkspace(moved, POD_ROOT)).rejects.toThrow(/could not replace/)
    expect(calls.some((call) => call.args[0] === 'clone')).toBe(false)
  })

  it('removes the checkout when the workspace converts back to from-scratch', async () => {
    // The pod's volume outlives the mode, and the runtime's cwd becomes the mount root: a `repo/`
    // left behind would sit in the scratch workspace as the previous repository's working tree.
    const agent = await withProvenMarker()
    const scratch = { ...agent, workspace: { ...agent.workspace, mode: 'from-scratch' } } as Agent
    await prepareWorkspaceForActivation(scratch, { reconcileMaterialization: true })
    checkoutExists = true
    expect(await prepareClusterWorkspace(scratch, POD_ROOT)).toBe(POD_ROOT)
    expect(cleared).toEqual([CHECKOUT])
    expect(calls).toEqual([])

    // And the marker now says scratch, so the next session does not empty it again.
    await prepareClusterWorkspace(scratch, POD_ROOT)
    expect(cleared).toEqual([CHECKOUT])
  })

  it('leaves a from-scratch cluster workspace alone, whose activation touches only bookkeeping', async () => {
    // It creates and empties the daemon-side directory that IS the bookkeeping identity; the pod's
    // volume is not involved, so refusing here would break the mode that already works. A real path,
    // because this one legitimately does touch this disk.
    const path = join(mkdtempSync(join(tmpdir(), 'ac-cluster-scratch-')), 'workspace')
    await expect(prepareWorkspaceForActivation(clusterAgent({ mode: 'from-scratch', path }))).resolves.toBeTypeOf(
      'function'
    )
    rmSync(dirname(path), { recursive: true, force: true })
  })
})
