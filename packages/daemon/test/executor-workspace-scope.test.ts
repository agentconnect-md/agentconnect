import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '../src/agents/agent-schema.js'
import { sessionKeyDirName } from '../src/acp/host-key.js'
import { testPlane } from './workspace-plane-support.js'
import {
  daemonGitCredentialTarget,
  initGitInjection,
  sandboxGitCredentialTarget
} from '../src/workspace/git-injection.js'
import type { GitRunner } from '../src/workspace/git-runner.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'
import { PodWorkspaceFs } from './fixtures/pod-workspace-fs.js'

/**
 * Preparing a session that runs on ANOTHER machine (session-executors.md §7).
 *
 * The scope is the whole point. An executor plane holds one session, never the agent: its holder
 * still owns the primary checkout, so a plane that answered for the agent would move that too. Every
 * filesystem question this preparation asks therefore has to carry the session it is about, or it
 * falls back to the holder's own disk while the Git beside it runs on the executor — which leaves a
 * clone half on each machine and a runtime standing in an empty directory.
 */

const AGENT = 'agent-spread'
const KEY = 'slack:C1:1700000000.000100:agent-spread'
const LEAF = sessionKeyDirName(KEY)

const workspaces = new WorkspaceManager()
let executorRoot: string
let holderRoot: string
let executor: PodWorkspaceFs
let calls: Array<{ cwd: string | undefined; args: string[] }>

function agent(): Agent {
  return {
    id: AGENT,
    name: AGENT,
    runtime: 'claude-acp',
    dir: join(holderRoot, 'agents', AGENT),
    mcpServers: [],
    managedSkills: [],
    workspace: {
      mode: 'git-repo',
      path: join(holderRoot, 'agents', AGENT, 'workspace'),
      gitRepo: 'https://github.com/example-org/example-repo.git',
      gitBranch: 'main',
      gitCredential: 'github-app',
      pullOnNewSession: true,
      skills: []
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent
}

/** The executor's shim exec channel: it answers the probes this path makes and creates what git would. */
function shimRunner(cwd: string | undefined): GitRunner {
  const run = async (args: string[]): Promise<string> => {
    calls.push({ cwd, args })
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') throw new Error('no checkout there')
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main'
    if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/example-org/example-repo.git'
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-list' && args.includes('--count')) return '0'
    if (args[0] === 'show-ref') throw new Error('no such ref')
    if (args[0] === 'symbolic-ref') return 'dev/alice/quiet-harbor'
    return ''
  }
  return {
    withEnv: () => shimRunner(cwd),
    raw: run,
    clone: async (repo, target, options = []) => {
      calls.push({ cwd, args: ['clone', repo, target, ...options] })
      await executor.mkdir(target)
      await executor.mkdir(`${target}/.git`)
    },
    pull: async () => ({ files: [], insertions: 0, deletions: 0 }),
    status: async () => ({ current: 'main', tracking: null, ahead: 0, behind: 0, files: [], clean: true }),
    log: async () => [],
    readBounded: async () => ({ out: Buffer.alloc(0), overflow: false })
  }
}

beforeEach(() => {
  holderRoot = mkdtempSync(join(tmpdir(), 'ac-xw-holder-'))
  // A real directory, so a question asked of the HOLDER's disk would succeed there rather than raising.
  executorRoot = mkdtempSync(join(tmpdir(), 'ac-xw-exec-'))
  executor = new PodWorkspaceFs(executorRoot)
  calls = []
  const sessionDir = join(executorRoot, 'sessions', LEAF)
  // The executor plane's own rule: this session's scope and the paths inside its environment, nothing wider.
  const plane = testPlane({
    workspacesOffDisk: true,
    gitRunnerFor: (_agentId, cwd) => shimRunner(cwd),
    workspaceFsFor: () => ({ fs: executor, mount: executorRoot })
  })
  workspaces.setPlaneResolver((scope) => {
    if (scope.agentId !== AGENT) return undefined
    if (scope.sessionKey === KEY) return plane
    if (scope.sessionKey !== undefined) return undefined
    return scope.path?.startsWith(sessionDir) ? plane : undefined
  })
  initGitInjection({
    targetFor: (_agentId, cwd) =>
      cwd?.startsWith(sessionDir)
        ? sandboxGitCredentialTarget(join(executorRoot, 'hs', 'ab12'), '/opt/agentconnect')
        : daemonGitCredentialTarget({ shimPath: join(holderRoot, 'helper.sh'), runDir: join(holderRoot, 'run') }),
    preWarm: async () => undefined,
    capabilityFor: (agentId) => `cap-${agentId}`
  })
})

afterEach(() => {
  workspaces.setPlaneResolver(undefined)
  for (const dir of [holderRoot, executorRoot]) rmSync(dir, { recursive: true, force: true })
})

describe('a session prepared on an executor', () => {
  it('asks every filesystem question of the machine it runs on, and leaves the holder’s disk untouched', async () => {
    const cwd = await workspaces.prepareExecutorWorkspace(agent(), executorRoot, {
      sessionKey: KEY,
      isolation: 'session',
      confined: true
    })
    const sessionDir = join(executorRoot, 'sessions', LEAF)
    expect(cwd).toBe(join(sessionDir, 'workspace'))
    // The clone landed in the executor's own filesystem, at the path the daemon composed for it.
    expect(await executor.stat(join(sessionDir, 'workspace', '.git'))).toBe('dir')
    expect(calls.some((call) => call.args[0] === 'clone')).toBe(true)
    // …and nothing of it was created on this daemon's disk, which is what a local fallback would have done.
    expect(existsSync(join(executorRoot, 'sessions'))).toBe(false)
    expect(existsSync(join(holderRoot, 'agents', AGENT, 'sessions'))).toBe(false)
  })

  it('resumes the clone that machine already holds, without cloning again', async () => {
    const request = { sessionKey: KEY, isolation: 'session' as const, confined: true as const }
    await workspaces.prepareExecutorWorkspace(agent(), executorRoot, request)
    calls = []
    const cwd = await workspaces.prepareExecutorWorkspace(agent(), executorRoot, request)
    expect(cwd).toBe(join(executorRoot, 'sessions', LEAF, 'workspace'))
    // The `.git` directory is on the executor, so the tier is read there and the session attaches to its work.
    expect(calls.some((call) => call.args[0] === 'clone')).toBe(false)
    expect(existsSync(join(executorRoot, 'sessions'))).toBe(false)
  })

  it('retires the session’s clones on that machine, and asks nothing of this one', async () => {
    const request = { sessionKey: KEY, isolation: 'session' as const, confined: true as const }
    await workspaces.prepareExecutorWorkspace(agent(), executorRoot, request)
    const removal = await workspaces.removeSessionWorktree(agent(), KEY, 'clones')
    expect(removal.outcome).not.toBe('failed')
    expect(await executor.stat(join(executorRoot, 'sessions', LEAF))).toBe('missing')
    expect(existsSync(join(executorRoot, 'sessions'))).toBe(false)
  })
})
