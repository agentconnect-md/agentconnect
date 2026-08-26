import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Agent } from '../src/agents/agent-schema.js'

const { rename: realRename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const renameMock = vi.fn(realRename)
vi.mock('node:fs/promises', () => ({ rename: renameMock }))

// Mock simple-git so clone/pull don't touch the network. The clone mock is
// reassignable per test (success / failure / slow) via `cloneImpl`.
let cloneImpl: (...args: any[]) => Promise<unknown>
let lastGitEnv: Record<string, string> | undefined
const pullMock = vi.fn().mockResolvedValue(undefined)
const rawMock = vi.fn().mockResolvedValue('')
vi.mock('simple-git', () => ({
  simpleGit: (options?: string | { baseDir?: string }) => {
    const cwd = typeof options === 'string' ? options : options?.baseDir
    // .env() returns the chain (mirrors the real fluent API) and records the
    // injected child env so the credential-injection tests can assert on it.
    const chain = {
      env: (e: Record<string, string>) => {
        lastGitEnv = e
        return chain
      },
      clone: (...args: any[]) => cloneImpl(...args),
      pull: pullMock,
      raw: (args: string[]) => rawMock(args, cwd)
    }
    return chain
  }
}))

// Imported after vi.mock so the mock is in effect.
const { WorkspaceManager } = await import('../src/workspace/workspace-manager.js')

// One plane per test file — the isolation Vitest's per-file module registry used to give.
const workspaces = new WorkspaceManager()
const { daemonGitCredentialTarget, initGitInjection } = await import('../src/workspace/git-injection.js')

// Made once and reused: `targetFor` is called on every pointer build, so minting a directory
// inside it would leave one behind per resolution.
let gitcredRunDirPath: string | undefined
const gitcredRunDir = (): string => (gitcredRunDirPath ??= mkdtempSync(join(tmpdir(), 'ac-ws-gitcred-')))

function fromScratchAgent(path: string): Agent {
  return {
    id: 'bot-a',
    dir: dirname(path),
    name: 'bot-a',
    status: 'active',
    runtime: 'claude',
    workspace: { mode: 'from-scratch', path, gitBranch: 'main', pullOnNewSession: true, skills: [] },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent
}

function gitRepoAgent(path: string, agentDir?: string): Agent {
  return {
    id: 'bot-git',
    dir: dirname(path),
    name: 'bot-git',
    status: 'active',
    runtime: 'claude',
    workspace: {
      mode: 'git-repo',
      path,
      gitRepo: 'https://github.com/acme/repo.git',
      gitBranch: 'main',
      ...(agentDir !== undefined ? { agentDir } : {}),
      pullOnNewSession: true,
      skills: []
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent
}

/** gitRepoAgent + the github-app credential channel (usesGithubApp true). */
function githubAppAgent(path: string): Agent {
  const agent = gitRepoAgent(path)
  return {
    ...agent,
    id: 'bot-git-app',
    workspace: {
      ...agent.workspace,
      gitRepo: 'https://github.com/acme/repo.git',
      gitCredential: 'github-app'
    }
  } as Agent
}

beforeEach(() => {
  cloneImpl = vi.fn().mockResolvedValue(undefined)
  renameMock.mockReset().mockImplementation(realRename)
  lastGitEnv = undefined
  pullMock.mockClear()
  rawMock.mockReset().mockResolvedValue('')
})

describe('prepareWorkspace', () => {
  it('creates the workspace dir for from-scratch mode (memory lives at the agent root, not here)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'workspace')
    const cwd = await workspaces.prepareWorkspace(fromScratchAgent(path))
    expect(cwd).toBe(path)
    expect(existsSync(path)).toBe(true)
    // memory.md is NOT created in the workspace anymore — it moved to <agent-root>/memory.md
    // (see memory/store.ts `ensureMemory`), so it stays out of the workspace / git repo.
    expect(existsSync(join(path, 'memory.md'))).toBe(false)
  })

  it('clones git-repo when the checkout has no .git, with branch + single-branch args', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    const cwd = await workspaces.prepareWorkspace(gitRepoAgent(path))
    expect(cwd).toBe(realpathSync(path))
    expect(cloneImpl).toHaveBeenCalledTimes(1)
    expect(cloneImpl).toHaveBeenCalledWith('https://github.com/acme/repo.git', path, [
      '--branch',
      'main',
      '--single-branch'
    ])
    // clone, not pull, on a fresh checkout
    expect(pullMock).not.toHaveBeenCalled()
  })

  it('keeps ssh clone targets working', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    const agent = gitRepoAgent(path)
    agent.workspace.gitRepo = 'ssh://git@github.com/acme/repo.git'

    await workspaces.prepareWorkspace(agent)

    expect(cloneImpl).toHaveBeenCalledWith('ssh://git@github.com/acme/repo.git', path, [
      '--branch',
      'main',
      '--single-branch'
    ])
  })

  it('rejects a hand-edited transport or unconfigured origin before clone or pull', async () => {
    for (const gitRepo of ['file:///var/lib/agentconnect/other-workspace', 'https://git.example/acme/repo.git']) {
      const fresh = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'fresh')
      const existing = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'existing')
      mkdirSync(join(existing, '.git'), { recursive: true })
      for (const path of [fresh, existing]) {
        const agent = gitRepoAgent(path)
        agent.workspace.gitRepo = gitRepo
        await expect(workspaces.prepareWorkspace(agent)).rejects.toThrow()
      }
    }

    expect(cloneImpl).not.toHaveBeenCalled()
    expect(pullMock).not.toHaveBeenCalled()
  })

  it('single-flights concurrent clones into the same cwd (dedupe)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    let resolveClone!: () => void
    cloneImpl = vi.fn().mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveClone = res
        })
    )
    const agent = gitRepoAgent(path)
    const p1 = workspaces.prepareWorkspace(agent)
    const p2 = workspaces.prepareWorkspace(agent) // arrives while p1's clone is in flight
    resolveClone()
    await Promise.all([p1, p2])
    expect(cloneImpl).toHaveBeenCalledTimes(1)
  })

  it('THROWS on clone failure (no on-disk fallback)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    cloneImpl = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(workspaces.prepareWorkspace(gitRepoAgent(path))).rejects.toThrow('boom')
  })

  it('pulls (not clones) when an existing .git checkout is present', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    await workspaces.prepareWorkspace(gitRepoAgent(dir))
    expect(cloneImpl).not.toHaveBeenCalled()
    expect(pullMock).toHaveBeenCalledWith(
      expect.stringMatching(/^agentconnect-[0-9a-f-]+$/),
      '+refs/heads/main:refs/remotes/origin/main',
      ['--ff-only', '--no-recurse-submodules']
    )
    expect(Object.values(lastGitEnv ?? {})).toContain('https://github.com/acme/repo.git')
  })

  it('ignores a checkout-controlled upstream when pulling an existing workspace', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    const agent = gitRepoAgent(dir)
    agent.workspace.gitBranch = 'release/v2'
    rawMock.mockImplementation(async (args: string[]) =>
      args[0] === 'remote' && args[1] === 'get-url' ? 'https://attacker.example/other.git\n' : ''
    )

    await workspaces.prepareWorkspace(agent)

    expect(pullMock).toHaveBeenCalledWith(
      expect.stringMatching(/^agentconnect-[0-9a-f-]+$/),
      '+refs/heads/release/v2:refs/remotes/origin/release/v2',
      ['--ff-only', '--no-recurse-submodules']
    )
    expect(Object.values(lastGitEnv ?? {})).toContain('https://github.com/acme/repo.git')
  })

  it('returns the canonical configured repository subdirectory', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    mkdirSync(join(dir, 'services', 'api'), { recursive: true })

    await expect(workspaces.prepareWorkspace(gitRepoAgent(dir, './services/api'))).resolves.toBe(
      realpathSync(join(dir, 'services', 'api'))
    )
  })

  it('rejects lexical traversal before cloning', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')

    await expect(workspaces.prepareWorkspace(gitRepoAgent(dir, '../outside'))).rejects.toThrow('working subdirectory')
    expect(cloneImpl).not.toHaveBeenCalled()
  })

  it('rejects a missing or non-directory configured path', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), 'not a directory')

    await expect(workspaces.prepareWorkspace(gitRepoAgent(dir, 'missing'))).rejects.toThrow('missing')
    await expect(workspaces.prepareWorkspace(gitRepoAgent(dir, 'README.md'))).rejects.toThrow('not a directory')
  })

  it('returns the canonical target of an in-repository symlink', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    mkdirSync(join(dir, 'packages', 'api'), { recursive: true })
    symlinkSync(join(dir, 'packages', 'api'), join(dir, 'api-link'))

    await expect(workspaces.prepareWorkspace(gitRepoAgent(dir, 'api-link'))).resolves.toBe(
      realpathSync(join(dir, 'packages', 'api'))
    )
  })

  it('rejects a symlink whose target is outside the repository', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ac-ws-'))
    const dir = join(base, 'co')
    const outside = join(base, 'outside')
    mkdirSync(join(dir, '.git'), { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(dir, 'outside-link'))

    await expect(workspaces.prepareWorkspace(gitRepoAgent(dir, 'outside-link'))).rejects.toThrow(
      'outside the repository'
    )
  })
})

describe('prepareSessionWorkspace', () => {
  it('fetches the exact trusted PR revision when the workspace includes a hooksPath', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-review-ws-'))
    const path = join(root, 'workspace')
    mkdirSync(join(path, '.git'), { recursive: true })
    const agent = gitRepoAgent(path)
    agent.workspace.pullOnNewSession = false
    const base = 'a'.repeat(40)
    const head = 'b'.repeat(40)

    rawMock.mockImplementation(async (args: string[], cwd?: string) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/acme/repo.git\n'
      if (cwd === path && args[0] === 'config') return 'include.path\0core.hooksPath\0'
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1) ?? ''
        if (ref.includes('/base')) return `${base}\n`
        return `${head}\n`
      }
      if (args[0] === 'fetch' && args.some((value) => value.includes('/merge:'))) {
        throw new Error('merge ref unavailable')
      }
      if (args[0] === 'show-ref') throw new Error('no such ref')
      if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(join(args.at(-2)!, '.git'), { recursive: true })
      }
      return ''
    })

    const request = {
      sessionKey: 'hook:repo#461:bot-git',
      isolation: 'session' as const,
      review: { pullNumber: 461, baseSha: base, headSha: head }
    }
    const cwd = await workspaces.prepareSessionWorkspace(agent, request)
    await workspaces.prepareSessionWorkspace(agent, request)

    expect(dirname(cwd)).toBe(realpathSync(workspaces.sessionWorktreeRoot(agent)))
    const addCall = rawMock.mock.calls
      .map((call) => call[0] as string[])
      .find((args) => args[0] === 'worktree' && args[1] === 'add')
    expect(addCall?.slice(0, 3)).toEqual(['worktree', 'add', '-b'])
    expect(addCall?.[3]).toMatch(/^dev\/[^/]+\/[a-z]+-[a-z]+$/)
    // --no-track, or git makes the remote-tracking start point this branch's upstream.
    expect(addCall?.[4]).toBe('--no-track')
    expect(realpathSync(addCall!.at(-2)!)).toBe(cwd)
    expect(addCall?.at(-1)).toBe(head)
    expect(
      rawMock.mock.calls.some(
        ([args, baseDir]) =>
          args[0] === 'fetch' &&
          baseDir === path &&
          args.includes(`+${base}:refs/agentconnect/reviews/${basename(cwd)}/base`) &&
          args.includes(`+refs/pull/461/head:refs/agentconnect/reviews/${basename(cwd)}/head`)
      )
    ).toBe(true)
    expect(rawMock.mock.calls.some(([args]) => args[0] === 'clean' && args[1] === '-ffdx')).toBe(true)
  })

  it('replaces a stale review checkout with an empty revision-only cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-review-fallback-'))
    const path = join(root, 'workspace')
    mkdirSync(join(path, '.git'), { recursive: true })
    const agent = gitRepoAgent(path)
    const request = {
      sessionKey: 'hook:repo#461:bot-git',
      isolation: 'session' as const,
      githubReviewRevisionOnly: true as const
    }

    const cwd = await workspaces.prepareSessionWorkspace(agent, request)
    mkdirSync(join(cwd, '.git'))
    writeFileSync(join(cwd, 'stale-review.txt'), 'must not be trusted')

    await expect(workspaces.prepareSessionWorkspace(agent, request)).resolves.toBe(cwd)
    expect(readdirSync(cwd)).toEqual([])
  })

  it('blocks unsafe config before ordinary linked-worktree creation when pull is disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-session-policy-'))
    const path = join(root, 'workspace')
    mkdirSync(join(path, '.git'), { recursive: true })
    const agent = gitRepoAgent(path)
    agent.workspace.pullOnNewSession = false

    rawMock.mockImplementation(async (args: string[], cwd?: string) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/acme/repo.git\n'
      if (cwd === path && args[0] === 'config') return 'filter.evil.smudge\0'
      return ''
    })

    await expect(
      workspaces.prepareSessionWorkspace(agent, { sessionKey: 'session-a', isolation: 'session' })
    ).rejects.toThrow('workspace Git configuration contains a disallowed network override or executable setting')
    expect(rawMock.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'add')).toBe(false)
  })

  it('uses a stable distinct worktree for each logical session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-session-ws-'))
    const path = join(root, 'workspace')
    mkdirSync(join(path, '.git'), { recursive: true })
    mkdirSync(join(path, 'agents', 'node-operator'), { recursive: true })
    const agent = gitRepoAgent(path, 'agents/node-operator')
    agent.workspace.pullOnNewSession = false
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/acme/repo.git\n'
      if (args[0] === 'show-ref') throw new Error('no such ref')
      if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(join(args.at(-2)!, '.git'), { recursive: true })
        mkdirSync(join(args.at(-2)!, 'agents', 'node-operator'), { recursive: true })
      }
      return args[0] === 'rev-parse' ? `${'c'.repeat(40)}\n` : ''
    })

    const first = await workspaces.prepareSessionWorkspace(agent, { sessionKey: 'session-a', isolation: 'session' })
    const again = await workspaces.prepareSessionWorkspace(agent, { sessionKey: 'session-a', isolation: 'session' })
    const second = await workspaces.prepareSessionWorkspace(agent, { sessionKey: 'session-b', isolation: 'session' })

    expect(again).toBe(first)
    expect(second).not.toBe(first)
    expect(
      await workspaces.additionalWorkspaceDirectories(agent, first, { sessionKey: 'session-a', isolation: 'session' })
    ).toEqual([realpathSync(workspaces.sessionWorktreePath(agent, 'session-a'))])
    expect(
      await workspaces.additionalWorkspaceDirectories(agent, second, { sessionKey: 'session-b', isolation: 'session' })
    ).toEqual([realpathSync(workspaces.sessionWorktreePath(agent, 'session-b'))])
  })

  /** A session worktree on `dev/<user>/<words>`, with control over which branch
   *  names the repository already holds. */
  function branchFixture(taken: string[] = []) {
    const root = mkdtempSync(join(tmpdir(), 'ac-session-branch-'))
    const path = join(root, 'workspace')
    mkdirSync(join(path, '.git'), { recursive: true })
    const agent = gitRepoAgent(path)
    agent.workspace.pullOnNewSession = false
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/acme/repo.git\n'
      // `show-ref --verify --quiet` exits non-zero for a ref that does not exist.
      if (args[0] === 'show-ref') {
        if (!taken.includes(args.at(-1)!.replace('refs/heads/', ''))) throw new Error('no such ref')
        return ''
      }
      if (args[0] === 'worktree' && args[1] === 'add') mkdirSync(join(args.at(-2)!, '.git'), { recursive: true })
      return args[0] === 'rev-parse' ? `${'c'.repeat(40)}\n` : ''
    })
    const addCall = () =>
      rawMock.mock.calls.map((call) => call[0] as string[]).find((args) => args[0] === 'worktree' && args[1] === 'add')
    return { agent, addCall }
  }

  it('checks the worktree out on its own branch, named for the user who opened the session', async () => {
    const { agent, addCall } = branchFixture()

    await workspaces.prepareSessionWorkspace(agent, {
      sessionKey: 'session-a',
      isolation: 'session',
      initiatedBy: 'Yu Long'
    })

    expect(addCall()?.[2]).toBe('-b')
    expect(addCall()?.[3]).toMatch(/^dev\/yu-long\/[a-zA-Z]+-[a-zA-Z]+$/)
  })

  it('draws another name when the repository already holds the one it drew', async () => {
    // Every word pair is taken, so the draws are exhausted and the random-suffix name ends the search.
    const { agent, addCall } = branchFixture()
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/acme/repo.git\n'
      if (args[0] === 'worktree' && args[1] === 'add') mkdirSync(join(args.at(-2)!, '.git'), { recursive: true })
      return args[0] === 'rev-parse' ? `${'c'.repeat(40)}\n` : ''
    })

    await workspaces.prepareSessionWorkspace(agent, {
      sessionKey: 'session-a',
      isolation: 'session',
      initiatedBy: 'yulong'
    })

    expect(rawMock.mock.calls.filter(([args]) => (args as string[])[0] === 'show-ref')).toHaveLength(5)
    expect(addCall()?.[3]).toMatch(/^dev\/yulong\/[a-zA-Z]+-[a-zA-Z]+-[0-9a-f]{6}$/)
  })
})

describe('workspaces.removeSessionWorktree(#485 retention GC)', () => {
  /** A git-repo agent plus one on-disk session worktree (a dir with a `.git` file,
   *  exactly what `worktree add` leaves behind). */
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'ac-wt-gc-'))
    const path = join(root, 'workspace')
    mkdirSync(join(path, '.git'), { recursive: true })
    const agent = gitRepoAgent(path)
    const requestedCwd = workspaces.sessionWorktreePath(agent, 'session-a')
    mkdirSync(requestedCwd, { recursive: true })
    const cwd = realpathSync(requestedCwd)
    writeFileSync(join(cwd, '.git'), 'gitdir: elsewhere')
    // Hand back the CANONICAL path: the GC re-derives its worktree path from the
    // realpath'd root before every destructive step, so that is the path it puts
    // on the Git command line. The two spellings differ wherever `$TMPDIR` sits
    // behind a symlink — on macOS it does (`/var` → `/private/var`).
    return { agent, cwd: realpathSync(cwd), id: basename(cwd) }
  }
  const gitCalls = () => rawMock.mock.calls.map((call) => call[0] as string[])

  it('removes a clean fully-pushed worktree: remove → prune → review-ref deletion', async () => {
    const { agent, cwd, id } = fixture()
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list') return '0\n'
      return ''
    })

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({ outcome: 'removed' })

    const calls = gitCalls()
    const removeAt = calls.findIndex((args) => args[0] === 'worktree' && args[1] === 'remove' && args[2] === cwd)
    const pruneAt = calls.findIndex((args) => args[0] === 'worktree' && args[1] === 'prune')
    expect(removeAt).toBeGreaterThanOrEqual(0)
    expect(pruneAt).toBeGreaterThan(removeAt) // prune runs AFTER remove
    for (const name of ['base', 'head', 'merge']) {
      expect(calls).toContainEqual(['update-ref', '-d', `refs/agentconnect/reviews/${id}/${name}`])
    }
    // The unique-commit probe must see every remote ref and this worktree's review refs.
    expect(calls).toContainEqual([
      'rev-list',
      '--count',
      'HEAD',
      '--not',
      '--remotes',
      `--glob=refs/agentconnect/reviews/${id}`
    ])
  })

  it('deletes the generated branch with the worktree, after the removal that unregisters it', async () => {
    const { agent, cwd } = fixture()
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list') return '0\n'
      if (args[0] === 'symbolic-ref') return 'dev/yulong/brave-otter\n'
      return ''
    })

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({ outcome: 'removed' })

    const calls = gitCalls()
    const readAt = calls.findIndex((args) => args[0] === 'symbolic-ref')
    const removeAt = calls.findIndex((args) => args[0] === 'worktree' && args[1] === 'remove' && args[2] === cwd)
    // The branch has to be read BEFORE the removal — afterwards there is no worktree to ask.
    expect(readAt).toBeGreaterThanOrEqual(0)
    expect(readAt).toBeLessThan(removeAt)
    expect(calls.findIndex((args) => args[0] === 'branch')).toBeGreaterThan(removeAt)
    expect(calls).toContainEqual(['branch', '-D', 'dev/yulong/brave-otter'])
  })

  it('never deletes a branch outside the session namespace, nor one on a retained worktree', async () => {
    const { agent } = fixture()
    // A worktree left on a branch of the repository's own — the agent switched to it.
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list') return '0\n'
      if (args[0] === 'symbolic-ref') return 'main\n'
      return ''
    })
    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({ outcome: 'removed' })
    expect(gitCalls().some((args) => args[0] === 'branch')).toBe(false)

    // Unique commits keep the worktree, so its branch must survive with them.
    rawMock.mockClear()
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list') return '3\n'
      if (args[0] === 'symbolic-ref') return 'dev/yulong/brave-otter\n'
      return ''
    })
    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({
      outcome: 'retained',
      reason: 'unique-commits'
    })
    expect(gitCalls().some((args) => args[0] === 'branch')).toBe(false)
  })

  it('removes a pre-branch worktree that is still at a detached HEAD', async () => {
    const { agent } = fixture()
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list') return '0\n'
      if (args[0] === 'symbolic-ref') throw new Error('ref HEAD is not a symbolic ref')
      return ''
    })

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({ outcome: 'removed' })
    expect(gitCalls().some((args) => args[0] === 'branch')).toBe(false)
  })

  it('retains a worktree with dirty/untracked files and never calls worktree remove', async () => {
    const { agent } = fixture()
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return ' M src/app.ts\n?? notes.md\n'
      return '0\n'
    })

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({ outcome: 'retained', reason: 'dirty' })
    expect(gitCalls().some((args) => args[0] === 'worktree')).toBe(false)
  })

  it('retains a worktree whose HEAD has commits unreachable from every remote ref', async () => {
    const { agent } = fixture()
    rawMock.mockImplementation(async (args: string[]) => (args[0] === 'rev-list' ? '2\n' : ''))

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({
      outcome: 'retained',
      reason: 'unique-commits'
    })
    expect(gitCalls().some((args) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false)
  })

  it('reports failed (keeping the session) when git refuses the removal', async () => {
    const { agent } = fixture()
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list') return '0\n'
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('worktree is locked')
      return ''
    })

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({
      outcome: 'failed',
      error: 'worktree is locked'
    })
  })

  it('an absent worktree still prunes stale registrations and review refs', async () => {
    const { agent, id } = fixture()
    const other = workspaces.sessionWorktreePath(agent, 'session-b')
    expect(other).not.toBe(workspaces.sessionWorktreePath(agent, 'session-a'))

    expect(await workspaces.removeSessionWorktree(agent, 'session-b')).toEqual({ outcome: 'absent' })

    const calls = gitCalls()
    expect(calls).toContainEqual(['worktree', 'prune'])
    expect(calls).toContainEqual(['update-ref', '-d', `refs/agentconnect/reviews/${basename(other)}/base`])
    expect(calls.some((args) => args[0] === 'status' || args[0] === 'rev-list')).toBe(false)
    // fixture()'s own worktree for session-a is untouched
    expect(existsSync(workspaces.sessionWorktreePath(agent, 'session-a'))).toBe(true)
    void id
  })

  it('deletes an EMPTY orphaned directory that git no longer tracks as a worktree', async () => {
    const { agent, cwd } = fixture()
    rmSync(join(cwd, '.git'))

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({ outcome: 'removed' })
    expect(existsSync(cwd)).toBe(false)
    expect(gitCalls()).toContainEqual(['worktree', 'prune'])
  })

  it('retains a NONEMPTY gitless directory — its files may be untracked user work', async () => {
    const { agent, cwd } = fixture()
    rmSync(join(cwd, '.git'))
    writeFileSync(join(cwd, 'notes.md'), 'work in progress')

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({ outcome: 'retained', reason: 'dirty' })
    expect(readFileSync(join(cwd, 'notes.md'), 'utf8')).toBe('work in progress')
  })

  it('refuses a symlinked worktrees ROOT without touching the link target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-wt-gc-'))
    const path = join(root, 'workspace')
    mkdirSync(join(path, '.git'), { recursive: true })
    const agent = gitRepoAgent(path)
    // An attacker-replaced root: `worktrees` is a symlink to a directory outside
    // the agent dir, holding a victim tree at the derived worktree id.
    const outside = mkdtempSync(join(tmpdir(), 'ac-wt-victim-'))
    const victim = join(outside, basename(workspaces.sessionWorktreePath(agent, 'session-a')))
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, 'precious.txt'), 'do not delete')
    symlinkSync(outside, workspaces.sessionWorktreeRoot(agent))

    const res = await workspaces.removeSessionWorktree(agent, 'session-a')
    expect(res.outcome).toBe('failed')
    expect(readFileSync(join(victim, 'precious.txt'), 'utf8')).toBe('do not delete')
  })

  it('refuses a symlinked worktree path', async () => {
    const { agent, cwd } = fixture()
    rmSync(cwd, { recursive: true, force: true })
    const outside = mkdtempSync(join(tmpdir(), 'ac-wt-outside-'))
    symlinkSync(outside, cwd)

    const res = await workspaces.removeSessionWorktree(agent, 'session-a')
    expect(res.outcome).toBe('failed')
    expect(existsSync(outside)).toBe(true) // the link target was never touched
  })
})

describe('workspaces.prefetchWorkspace(reconcile-time eager clone)', () => {
  it('clones a git-repo with no checkout yet (warms it ahead of the first session)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    await workspaces.prefetchWorkspace(gitRepoAgent(path))
    expect(cloneImpl).toHaveBeenCalledTimes(1)
    expect(cloneImpl).toHaveBeenCalledWith('https://github.com/acme/repo.git', path, [
      '--branch',
      'main',
      '--single-branch'
    ])
  })

  it('is a no-op for from-scratch mode', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'workspace')
    await workspaces.prefetchWorkspace(fromScratchAgent(path))
    expect(cloneImpl).not.toHaveBeenCalled()
  })

  it('is a no-op (no re-clone, no pull) when a .git checkout already exists', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    await workspaces.prefetchWorkspace(gitRepoAgent(dir))
    expect(cloneImpl).not.toHaveBeenCalled()
    expect(pullMock).not.toHaveBeenCalled()
  })
})

describe('prepareWorkspaceForActivation', () => {
  it('clones into a sibling and atomically replaces an empty scratch directory', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-convert-')), 'workspace')
    cloneImpl = vi.fn().mockImplementation(async (_repo: string, target: string) => {
      mkdirSync(join(target, '.git'), { recursive: true })
      writeFileSync(join(target, 'README.md'), 'converted')
    })

    const rollback = await workspaces.prepareWorkspaceForActivation(gitRepoAgent(path))
    const cloneTarget = (cloneImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string
    expect(cloneTarget).not.toBe(path)
    expect(existsSync(join(path, '.git'))).toBe(true)
    expect(existsSync(cloneTarget)).toBe(false)

    await rollback()
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(path)).toEqual([])
  })

  it.runIf(process.platform === 'win32')('retries transient Windows directory rename failures', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ac-ws-convert-'))
    const path = join(parent, 'workspace')
    let failed = false
    renameMock.mockImplementation(async (from, to) => {
      if (!failed && from === path) {
        failed = true
        throw Object.assign(new Error('directory is busy'), { code: 'EPERM' })
      }
      await realRename(from, to)
    })
    cloneImpl = vi.fn().mockImplementation(async (_repo: string, target: string) => {
      mkdirSync(join(target, '.git'), { recursive: true })
    })

    await workspaces.prepareWorkspaceForActivation(gitRepoAgent(path))

    expect(failed).toBe(true)
    expect(existsSync(join(path, '.git'))).toBe(true)
    expect(readdirSync(parent).filter((entry) => entry.startsWith('workspace.old-'))).toEqual([])
  })

  it('refuses a non-empty scratch directory without starting a clone', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-convert-')), 'workspace')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'keep.txt'), 'do not overwrite')

    await expect(workspaces.prepareWorkspaceForActivation(gitRepoAgent(path))).rejects.toThrow('workspace is not empty')
    expect(cloneImpl).not.toHaveBeenCalled()
    expect(existsSync(join(path, 'keep.txt'))).toBe(true)
  })

  it('leaves the original empty directory intact when the staged clone fails', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-convert-')), 'workspace')
    cloneImpl = vi.fn().mockRejectedValue(new Error('clone failed'))

    await expect(workspaces.prepareWorkspaceForActivation(gitRepoAgent(path))).rejects.toThrow('clone failed')
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(path)).toEqual([])
  })

  it('preserves scratch data that appears while the staged clone is running', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-convert-')), 'workspace')
    cloneImpl = vi.fn().mockImplementation(async (_repo: string, target: string) => {
      mkdirSync(join(target, '.git'), { recursive: true })
      writeFileSync(join(path, 'keep.txt'), 'do not overwrite')
    })

    await expect(workspaces.prepareWorkspaceForActivation(gitRepoAgent(path))).rejects.toThrow(
      'workspace changed while conversion was cloning'
    )
    expect(existsSync(join(path, 'keep.txt'))).toBe(true)
    expect(existsSync(join(path, '.git'))).toBe(false)
  })

  it('does not accept a checkout that appeared after an initial conversion empty check', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-convert-')), 'workspace')
    mkdirSync(join(path, '.git'), { recursive: true })

    await expect(
      workspaces.prepareWorkspaceForActivation(gitRepoAgent(path), { allowExistingCheckout: false })
    ).rejects.toThrow('workspace changed after its empty check')
    expect(cloneImpl).not.toHaveBeenCalled()
  })

  it('preserves local files when repository and branch materialization are unchanged', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-edit-')), 'workspace')
    const current = githubAppAgent(path)
    initGitInjection({
      targetFor: () => daemonGitCredentialTarget({ shimPath: '/run/helper.sh', runDir: gitcredRunDir() }),
      preWarm: async () => undefined,
      capabilityFor: (agentId) => `cap-${agentId}`
    })
    mkdirSync(join(path, '.git'), { recursive: true })
    writeFileSync(join(path, 'local.txt'), 'keep me')
    workspaces.recordWorkspaceMaterialization(current)
    // Older daemons recorded the conventional `.git` suffix in this marker.
    writeFileSync(
      join(dirname(path), `.${basename(path)}.workspace-materialization.json`),
      JSON.stringify({
        version: 1,
        key: JSON.stringify({
          mode: 'github',
          repo: 'https://github.com/acme/repo.git',
          branch: 'main'
        })
      })
    )
    rawMock.mockImplementation(async (args: string[]) =>
      args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/acme/repo.git\n' : ''
    )

    const rollback = await workspaces.prepareWorkspaceForActivation(
      { ...current, workspace: { ...current.workspace, gitRepo: 'https://github.com/acme/repo' } } as Agent,
      { reconcileMaterialization: true }
    )

    expect(cloneImpl).not.toHaveBeenCalled()
    expect(existsSync(join(path, 'local.txt'))).toBe(true)
    await rollback()
    expect(existsSync(join(path, 'local.txt'))).toBe(true)
  })

  it('replaces a historical App-backed checkout materialized from a non-GitHub origin', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-edit-')), 'workspace')
    const agent = githubAppAgent(path)
    initGitInjection({
      targetFor: () => daemonGitCredentialTarget({ shimPath: '/run/helper.sh', runDir: gitcredRunDir() }),
      preWarm: async () => undefined,
      capabilityFor: (agentId) => `cap-${agentId}`
    })
    mkdirSync(join(path, '.git'), { recursive: true })
    writeFileSync(join(path, 'untrusted.txt'), 'wrong-host content')
    workspaces.recordWorkspaceMaterialization(agent)
    rawMock.mockImplementation(async (args: string[]) =>
      args[0] === 'remote' && args[1] === 'get-url' ? 'https://other-host.example/acme/repo.git\n' : ''
    )
    cloneImpl = vi.fn().mockImplementation(async (_repo: string, target: string) => {
      mkdirSync(join(target, '.git'), { recursive: true })
      writeFileSync(join(target, 'README.md'), 'authorized GitHub content')
    })

    const rollback = await workspaces.prepareWorkspaceForActivation(agent, { reconcileMaterialization: true })

    expect(cloneImpl).toHaveBeenCalledWith('https://github.com/acme/repo.git', expect.any(String), [
      '--branch',
      'main',
      '--single-branch'
    ])
    expect(existsSync(join(path, 'untrusted.txt'))).toBe(false)
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('authorized GitHub content')
    await rollback()
  })

  it('retries a failed rename convergence without replacing local files on a later agentDir-only edit', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-edit-')), 'workspace')
    const current = githubAppAgent(path)
    current.workspace.gitRepo = 'https://github.com/acme/old-name'
    mkdirSync(join(path, '.git'), { recursive: true })
    mkdirSync(join(path, 'packages', 'service'), { recursive: true })
    writeFileSync(join(path, 'local.txt'), 'keep me')
    workspaces.recordWorkspaceMaterialization(current)
    let failSetUrl = true
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/acme/old-name\n'
      if (args[0] === 'remote' && args[1] === 'set-url' && failSetUrl) throw new Error('config locked')
      return ''
    })

    const renamed = {
      ...current,
      workspace: { ...current.workspace, gitRepo: 'https://github.com/acme/new-name' }
    } as Agent
    await expect(workspaces.convergeGithubAppWorkspaceRename(renamed)).rejects.toThrow('config locked')
    failSetUrl = false

    const rollback = await workspaces.prepareWorkspaceForActivation(
      { ...renamed, workspace: { ...renamed.workspace, agentDir: 'packages/service' } } as Agent,
      { reconcileMaterialization: true }
    )

    expect(
      rawMock.mock.calls.filter(
        (call) =>
          JSON.stringify(call[0]) ===
          JSON.stringify(['remote', 'set-url', 'origin', 'https://github.com/acme/new-name'])
      )
    ).toHaveLength(2)
    expect(cloneImpl).not.toHaveBeenCalled()
    expect(readFileSync(join(path, 'local.txt'), 'utf8')).toBe('keep me')
    await rollback()
    expect(readFileSync(join(path, 'local.txt'), 'utf8')).toBe('keep me')
  })

  it('preserves the recorded source across a retry and replaces files when the repository changes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-edit-')), 'workspace')
    const current = gitRepoAgent(path)
    mkdirSync(join(path, '.git'), { recursive: true })
    writeFileSync(join(path, 'local.txt'), 'discard me')
    workspaces.recordWorkspaceMaterialization(current)
    cloneImpl = vi.fn().mockImplementation(async (_repo: string, target: string) => {
      mkdirSync(join(target, '.git'), { recursive: true })
      writeFileSync(join(target, 'README.md'), 'replacement')
    })
    const target = {
      ...current,
      workspace: { ...current.workspace, gitRepo: 'https://github.com/acme/another.git', gitBranch: 'next' }
    } as Agent
    // A crash can leave the target spec on disk before materialization. The next
    // detach must not overwrite the source marker merely because it sees that spec.
    workspaces.ensureWorkspaceMaterialization(target)

    const rollback = await workspaces.prepareWorkspaceForActivation(target, { reconcileMaterialization: true })

    expect(existsSync(join(path, 'local.txt'))).toBe(false)
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('replacement')
    await rollback()
    expect(readdirSync(path)).toEqual([])
  })
})

describe('prepareWorkspace repo-local helper re-pin (github-app)', () => {
  beforeEach(() => {
    initGitInjection({
      targetFor: () => daemonGitCredentialTarget({ shimPath: '/run/helper.sh', runDir: gitcredRunDir() }),
      preWarm: async () => undefined,
      capabilityFor: (agentId) => `cap-${agentId}`
    })
    rawMock.mockImplementation(async (args: string[]) =>
      args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/acme/repo.git\n' : ''
    )
  })

  it('re-pins an existing checkout to the CURRENT agent id (a recreated agent adopts a stale pin)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ws-repin-'))
    mkdirSync(join(dir, '.git'))

    await workspaces.prepareWorkspace(githubAppAgent(dir))

    const configCalls = rawMock.mock.calls.map((c) => c[0] as string[])
    expect(configCalls).toContainEqual(['config', '--replace-all', 'credential.https://github.com.helper', ''])
    const add = configCalls.find((c) => c[1] === '--add')
    expect(add?.[3]).toBe("!'/run/helper.sh' bot-git-app")
    expect(configCalls).toContainEqual(['config', 'credential.https://github.com.useHttpPath', 'true'])
    expect(pullMock).toHaveBeenCalled() // re-pin happens in addition to the pull, not instead of it
    expect(cloneImpl).not.toHaveBeenCalled()
  })

  it('repoints an existing checkout after its GitHub repository is renamed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ws-repin-'))
    mkdirSync(join(dir, '.git'))
    const agent = githubAppAgent(dir)
    agent.workspace.gitRepo = 'https://github.com/acme/new-name'
    rawMock.mockImplementation(async (args: string[]) =>
      args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/acme/old-name\n' : ''
    )

    await workspaces.prepareWorkspace(agent)

    expect(rawMock.mock.calls.map((call) => call[0])).toContainEqual(['remote', 'get-url', 'origin'])
    expect(rawMock.mock.calls.map((call) => call[0])).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/acme/new-name'
    ])
    expect(cloneImpl).not.toHaveBeenCalled()
  })

  it('sanitizes host git context before inspecting and repointing an origin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ws-repin-'))
    mkdirSync(join(dir, '.git'))
    const agent = githubAppAgent(dir)
    agent.workspace.gitRepo = 'https://github.com/acme/new-name'
    const previousGitDir = process.env.GIT_DIR
    process.env.GIT_DIR = '/tmp/attacker-controlled-git-dir'
    rawMock.mockImplementation(async (args: string[]) => {
      expect(lastGitEnv).not.toHaveProperty('GIT_DIR')
      expect(lastGitEnv?.GIT_ALLOW_PROTOCOL).toBe('')
      return args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/acme/old-name\n' : ''
    })

    try {
      await workspaces.prepareWorkspace(agent)
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
    }

    expect(rawMock.mock.calls.map((call) => call[0])).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/acme/new-name'
    ])
  })

  it('refuses to run an App-backed checkout whose origin is not GitHub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ws-repin-'))
    mkdirSync(join(dir, '.git'))
    rawMock.mockImplementation(async (args: string[]) =>
      args[0] === 'remote' && args[1] === 'get-url' ? 'https://other-host.example/acme/repo.git\n' : ''
    )

    await expect(workspaces.prepareWorkspace(githubAppAgent(dir))).rejects.toThrow(
      'origin is not a trusted GitHub remote'
    )
    expect(pullMock).not.toHaveBeenCalled()
  })

  it('fails closed when an App-backed origin cannot be rewritten', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ws-repin-'))
    mkdirSync(join(dir, '.git'))
    const agent = githubAppAgent(dir)
    agent.workspace.gitRepo = 'https://github.com/acme/new-name'
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/acme/old-name\n'
      if (args[0] === 'remote' && args[1] === 'set-url') throw new Error('config locked')
      return ''
    })

    await expect(workspaces.prepareWorkspace(agent)).rejects.toThrow('config locked')
    expect(pullMock).not.toHaveBeenCalled()
  })

  it('leaves a credential-free non-github-app origin untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ws-repin-'))
    mkdirSync(join(dir, '.git'))
    rawMock.mockImplementation(async (args: string[]) =>
      args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/acme/repo.git\n' : ''
    )

    await workspaces.prepareWorkspace(gitRepoAgent(dir))

    expect(rawMock.mock.calls.map((call) => call[0])).toContainEqual(['remote', 'get-url', 'origin'])
    expect(rawMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/acme/repo.git'
    ])
  })

  it('removes credentials from a historical anonymous origin before pull', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ws-repin-'))
    mkdirSync(join(dir, '.git'))
    rawMock.mockImplementation(async (args: string[]) =>
      args[0] === 'remote' && args[1] === 'get-url'
        ? 'https://legacy-user:legacy-token@github.com/acme/repo.git?token=query-secret\n'
        : ''
    )

    await workspaces.prepareWorkspace(gitRepoAgent(dir))

    expect(rawMock.mock.calls.map((call) => call[0])).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/acme/repo.git'
    ])
    expect(pullMock).toHaveBeenCalled()
  })

  it('repoints a historical shorthand origin before pull', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ws-repin-'))
    mkdirSync(join(dir, '.git'))
    const agent = gitRepoAgent(dir)
    agent.workspace.gitRepo = 'https://github.com/acme/repo'
    rawMock.mockImplementation(async (args: string[]) =>
      args[0] === 'remote' && args[1] === 'get-url' ? 'acme/repo\n' : ''
    )

    await workspaces.prepareWorkspace(agent)

    expect(rawMock.mock.calls.map((call) => call[0])).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/acme/repo'
    ])
    expect(pullMock).toHaveBeenCalled()
  })
})

describe('workspaces.clusterWorkspaceCwd(--k8s pod coordinates)', () => {
  it('hands a from-scratch agent the pod root, never the daemon-disk workspace path', () => {
    const agent = fromScratchAgent('/var/lib/agentconnect/agents/bot-a/workspace')
    expect(workspaces.clusterWorkspaceCwd(agent, '/agent')).toBe('/agent')
  })

  it('falls back to the historical mount for a legacy shim that reported none', () => {
    const agent = fromScratchAgent('/var/lib/agentconnect/agents/bot-a/workspace')
    expect(workspaces.clusterWorkspaceCwd(agent, undefined)).toBe('/agent')
  })

  it('checks a git-repo workspace out below the mount, never at the daemon-disk path', () => {
    // The mount is also the runtime's HOME, so a working tree at the root would sit on top of its
    // `.claude`/`.codex` state. What must never appear is the daemon's own workspace path.
    const agent = gitRepoAgent('/var/lib/agentconnect/agents/bot-git/workspace')
    expect(workspaces.clusterWorkspaceCwd(agent, '/agent')).toBe('/agent/repo')
    expect(workspaces.clusterWorkspaceCwd(agent, '/agent')).not.toContain('/var/lib/agentconnect')
  })

  it('puts a session-isolated cwd in its own worktree beside the checkout', () => {
    // The worktrees parent is the pod's, not the agent directory's: the daemon composes it in the
    // coordinates the runtime and the shim both read.
    const agent = gitRepoAgent('/var/lib/agentconnect/agents/bot-git/workspace')
    const id = workspaces.sessionWorktreeId('sess-1')
    expect(workspaces.clusterWorkspaceCwd(agent, '/agent', { isolation: 'session', sessionKey: 'sess-1' })).toBe(
      `/agent/worktrees/${id}`
    )
  })

  it('keeps a from-scratch workspace on the mount, which has no clone to branch a worktree off', () => {
    const agent = fromScratchAgent('/var/lib/agentconnect/agents/bot-a/workspace')
    expect(workspaces.clusterWorkspaceCwd(agent, '/agent', { isolation: 'session', sessionKey: 'sess-1' })).toBe(
      '/agent'
    )
  })
})
