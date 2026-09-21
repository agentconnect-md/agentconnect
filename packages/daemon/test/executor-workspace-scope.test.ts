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
 * The scope is the whole point. An executor holds one session, never the agent: its holder keeps the
 * primary checkout and the agent's own reference subtrees, so a plane that answered for the agent
 * would move those too. Every filesystem question therefore has to carry the session, or the path,
 * it is about — or it lands on the holder while the Git beside it runs on the executor, which leaves
 * a clone half on each machine and a runtime standing in an empty directory.
 *
 * Both machines are in-memory filesystems here, so a question asked of the wrong one is visible
 * rather than merely absent.
 */

const AGENT = 'agent-spread'
const KEY = 'slack:C1:1700000000.000100:agent-spread'
const LEAF = sessionKeyDirName(KEY)
const LIBRARY = 'https://github.com/example-org/library.git'

const workspaces = new WorkspaceManager()
let executorRoot: string
let holderRoot: string
let agentDir: string
let sessionDir: string
/** The machine the session runs on, and the one that holds the agent. */
let executor: PodWorkspaceFs
let holder: PodWorkspaceFs
let calls: Array<{ cwd: string | undefined; args: string[] }>

function agent(additionalRepos: Array<{ repoFullName: string; repoId: string }> = []): Agent {
  return {
    id: AGENT,
    name: AGENT,
    runtime: 'claude-acp',
    dir: agentDir,
    mcpServers: [],
    managedSkills: [],
    workspace: {
      mode: 'git-repo',
      path: join(agentDir, 'workspace'),
      gitRepo: 'https://github.com/example-org/example-repo.git',
      gitBranch: 'main',
      gitCredential: 'github-app',
      pullOnNewSession: true,
      skills: [],
      ...(additionalRepos.length ? { additionalRepos } : {})
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent
}

/** One machine's exec channel: it answers the probes this path makes and creates what git would, in that machine's filesystem. */
function runner(fs: PodWorkspaceFs, cwd: string | undefined): GitRunner {
  const run = async (args: string[]): Promise<string> => {
    calls.push({ cwd, args })
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
      if ((await fs.stat(join(cwd ?? '', '.git'))) === 'missing') throw new Error('no checkout there')
      return '.git'
    }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main'
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return cwd?.includes('library') ? LIBRARY : 'https://github.com/example-org/example-repo.git'
    }
    if (args[0] === 'ls-remote') return `ref: refs/heads/main\tHEAD\n${'a'.repeat(40)}\tHEAD\n`
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-list' && args.includes('--count')) return '0'
    if (args[0] === 'show-ref') throw new Error('no such ref')
    if (args[0] === 'symbolic-ref') return 'dev/alice/quiet-harbor'
    return ''
  }
  return {
    withEnv: () => runner(fs, cwd),
    raw: run,
    clone: async (repo, target, options = []) => {
      calls.push({ cwd, args: ['clone', repo, target, ...options] })
      const at = target.startsWith('/') ? target : join(cwd ?? '', target)
      await fs.mkdir(at)
      await fs.mkdir(`${at}/.git`)
    },
    pull: async () => ({ files: [], insertions: 0, deletions: 0 }),
    status: async () => ({ current: 'main', tracking: null, ahead: 0, behind: 0, files: [], clean: true }),
    log: async () => [],
    readBounded: async () => ({ out: Buffer.alloc(0), overflow: false })
  }
}

beforeEach(() => {
  holderRoot = mkdtempSync(join(tmpdir(), 'ac-xw-holder-'))
  executorRoot = mkdtempSync(join(tmpdir(), 'ac-xw-exec-'))
  agentDir = join(holderRoot, 'agents', AGENT)
  sessionDir = join(executorRoot, 'sessions', LEAF)
  executor = new PodWorkspaceFs(executorRoot)
  holder = new PodWorkspaceFs(holderRoot, agentDir)
  calls = []
  const onExecutor = (path: string | undefined): boolean => path?.startsWith(sessionDir) === true
  const executorPlane = testPlane({
    workspacesOffDisk: true,
    gitRunnerFor: (_agentId, cwd) => runner(executor, cwd),
    workspaceFsFor: () => ({ fs: executor, mount: executorRoot })
  })
  // The holder's own disk, as a plane too, so this test needs no real Git for the agent's own roots.
  const holderPlane = testPlane({
    workspacesOffDisk: true,
    gitRunnerFor: (_agentId, cwd) => runner(holder, cwd),
    workspaceFsFor: () => ({ fs: holder, mount: agentDir })
  })
  // The executor plane's own rule: this session's scope and the paths inside its environment, nothing wider.
  workspaces.setPlaneResolver((scope) => {
    if (scope.agentId !== AGENT) return undefined
    if (scope.sessionKey === KEY || onExecutor(scope.path)) return executorPlane
    return scope.sessionKey === undefined ? holderPlane : undefined
  })
  initGitInjection({
    targetFor: (_agentId, cwd) =>
      onExecutor(cwd)
        ? sandboxGitCredentialTarget(join(executorRoot, 'hs', 'ab12'), '/opt/agentconnect')
        : daemonGitCredentialTarget({ shimPath: join(holderRoot, 'helper.sh'), runDir: join(holderRoot, 'run') }),
    preWarm: async () => undefined,
    capabilityFor: (agentId) => `cap-${agentId}`
  })
})

/** Neither machine may hold a path composed for the other: that is what a wrongly scoped question creates. */
function expectNoCrossedPaths(): void {
  const entries = (fs: PodWorkspaceFs): string[] => [...fs.dirs, ...fs.files.keys()]
  expect(entries(holder).filter((path) => path.startsWith(executorRoot))).toEqual([])
  expect(entries(executor).filter((path) => path.startsWith(agentDir))).toEqual([])
}

afterEach(() => {
  workspaces.setPlaneResolver(undefined)
  for (const dir of [holderRoot, executorRoot]) rmSync(dir, { recursive: true, force: true })
})

const request = { sessionKey: KEY, isolation: 'session' as const, confined: true as const }

describe('a session prepared on an executor', () => {
  it('asks every filesystem question of the machine it runs on, and leaves the holder’s alone', async () => {
    const cwd = await workspaces.prepareExecutorWorkspace(agent(), executorRoot, request)
    expect(cwd).toBe(join(sessionDir, 'workspace'))
    // The clone landed in the executor's own filesystem, at the path the daemon composed for it.
    expect(await executor.stat(join(sessionDir, 'workspace', '.git'))).toBe('dir')
    expect(calls.some((call) => call.args[0] === 'clone')).toBe(true)
    // …and nothing of the session was created on the holder, which is what an agent-scoped question would have done.
    expect(await holder.stat(join(agentDir, 'sessions'))).toBe('missing')
    expect(existsSync(join(executorRoot, 'sessions'))).toBe(false)
    expectNoCrossedPaths()
  })

  it('resumes the clone that machine already holds, without cloning again', async () => {
    await workspaces.prepareExecutorWorkspace(agent(), executorRoot, request)
    calls = []
    const cwd = await workspaces.prepareExecutorWorkspace(agent(), executorRoot, request)
    expect(cwd).toBe(join(sessionDir, 'workspace'))
    // The `.git` directory is on the executor, so the tier is read there and the session attaches to its work.
    expect(calls.some((call) => call.args[0] === 'clone')).toBe(false)
  })

  it('hands the runtime the secondary repository it cloned there, not one the holder would have named', async () => {
    const withRepo = agent([{ repoFullName: 'example-org/library', repoId: '42' }])
    await workspaces.prepareExecutorWorkspace(withRepo, executorRoot, request)
    const sessionClone = join(sessionDir, 'repos', 'example-org', 'library')
    // The session's own clone of the second repository is on the executor…
    expect(await executor.stat(join(sessionClone, '.git'))).toBe('dir')
    // …and it is the directory the runtime is handed; an agent-scoped read would have found none and dropped it.
    const roots = await workspaces.readySecondaryRoots(withRepo, { sessionKey: KEY, isolation: 'session' })
    expect(roots.map((root) => root.path)).toEqual([sessionClone])
    // The reference subtree it was resolved through is the holder's own, in the holder's coordinates.
    expect(await holder.stat(join(agentDir, 'repos', 'example-org', 'library'))).toBe('dir')
    expectNoCrossedPaths()
  })

  it('retires the session’s clones on that machine, and asks nothing of this one', async () => {
    await workspaces.prepareExecutorWorkspace(agent(), executorRoot, request)
    const removal = await workspaces.removeSessionWorktree(agent(), KEY, 'clones')
    expect(removal.outcome).not.toBe('failed')
    expect(await executor.stat(sessionDir)).toBe('missing')
  })
})
