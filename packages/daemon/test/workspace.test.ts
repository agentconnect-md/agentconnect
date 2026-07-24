import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Agent } from '../src/agents/agent-schema.js'

// Mock simple-git so clone/pull don't touch the network. The clone mock is
// reassignable per test (success / failure / slow) via `cloneImpl`.
let cloneImpl: (...args: any[]) => Promise<unknown>
let lastGitEnv: Record<string, string> | undefined
const pullMock = vi.fn().mockResolvedValue(undefined)
const rawMock = vi.fn().mockResolvedValue('')
vi.mock('simple-git', () => ({
  simpleGit: (_cwd?: string) => {
    // .env() returns the chain (mirrors the real fluent API) and records the
    // injected child env so the credential-injection tests can assert on it.
    const chain = {
      env: (e: Record<string, string>) => {
        lastGitEnv = e
        return chain
      },
      clone: (...args: any[]) => cloneImpl(...args),
      pull: pullMock,
      raw: rawMock
    }
    return chain
  }
}))

// Imported after vi.mock so the mock is in effect.
const {
  convergeGithubAppWorkspaceRename,
  ensureWorkspaceMaterialization,
  prepareWorkspace,
  prepareWorkspaceForActivation,
  prefetchWorkspace,
  recordWorkspaceMaterialization
} = await import('../src/workspace/workspace-manager.js')
const { initGitInjection } = await import('../src/workspace/git-injection.js')

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
  } as Agent
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
      gitRepo: 'https://example.com/repo.git',
      gitBranch: 'main',
      ...(agentDir !== undefined ? { agentDir } : {}),
      pullOnNewSession: true,
      skills: []
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as Agent
}

/** gitRepoAgent + the github-app credential channel (usesGithubApp true). */
function githubAppAgent(path: string): Agent {
  const agent = gitRepoAgent(path)
  return { ...agent, id: 'bot-git-app', workspace: { ...agent.workspace, gitCredential: 'github-app' } } as Agent
}

beforeEach(() => {
  cloneImpl = vi.fn().mockResolvedValue(undefined)
  pullMock.mockClear()
  rawMock.mockReset().mockResolvedValue('')
})

describe('prepareWorkspace', () => {
  it('creates the workspace dir for from-scratch mode (memory lives at the agent root, not here)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'workspace')
    const cwd = await prepareWorkspace(fromScratchAgent(path))
    expect(cwd).toBe(path)
    expect(existsSync(path)).toBe(true)
    // memory.md is NOT created in the workspace anymore — it moved to <agent-root>/memory.md
    // (see agents/memory.ts `ensureMemory`), so it stays out of the workspace / git repo.
    expect(existsSync(join(path, 'memory.md'))).toBe(false)
  })

  it('clones git-repo when the checkout has no .git, with branch + single-branch args', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    const cwd = await prepareWorkspace(gitRepoAgent(path))
    expect(cwd).toBe(realpathSync(path))
    expect(cloneImpl).toHaveBeenCalledTimes(1)
    expect(cloneImpl).toHaveBeenCalledWith('https://example.com/repo.git', path, [
      '--branch',
      'main',
      '--single-branch'
    ])
    // clone, not pull, on a fresh checkout
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
    const p1 = prepareWorkspace(agent)
    const p2 = prepareWorkspace(agent) // arrives while p1's clone is in flight
    resolveClone()
    await Promise.all([p1, p2])
    expect(cloneImpl).toHaveBeenCalledTimes(1)
  })

  it('THROWS on clone failure (no on-disk fallback)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    cloneImpl = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(prepareWorkspace(gitRepoAgent(path))).rejects.toThrow('boom')
  })

  it('pulls (not clones) when an existing .git checkout is present', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    await prepareWorkspace(gitRepoAgent(dir))
    expect(cloneImpl).not.toHaveBeenCalled()
    expect(pullMock).toHaveBeenCalledTimes(1)
  })

  it('returns the canonical configured repository subdirectory', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    mkdirSync(join(dir, 'services', 'api'), { recursive: true })

    await expect(prepareWorkspace(gitRepoAgent(dir, './services/api'))).resolves.toBe(
      realpathSync(join(dir, 'services', 'api'))
    )
  })

  it('rejects lexical traversal before cloning', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')

    await expect(prepareWorkspace(gitRepoAgent(dir, '../outside'))).rejects.toThrow('working subdirectory')
    expect(cloneImpl).not.toHaveBeenCalled()
  })

  it('rejects a missing or non-directory configured path', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), 'not a directory')

    await expect(prepareWorkspace(gitRepoAgent(dir, 'missing'))).rejects.toThrow('missing')
    await expect(prepareWorkspace(gitRepoAgent(dir, 'README.md'))).rejects.toThrow('not a directory')
  })

  it('returns the canonical target of an in-repository symlink', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    mkdirSync(join(dir, 'packages', 'api'), { recursive: true })
    symlinkSync(join(dir, 'packages', 'api'), join(dir, 'api-link'))

    await expect(prepareWorkspace(gitRepoAgent(dir, 'api-link'))).resolves.toBe(
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

    await expect(prepareWorkspace(gitRepoAgent(dir, 'outside-link'))).rejects.toThrow('outside the repository')
  })
})

describe('prefetchWorkspace (reconcile-time eager clone)', () => {
  it('clones a git-repo with no checkout yet (warms it ahead of the first session)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    await prefetchWorkspace(gitRepoAgent(path))
    expect(cloneImpl).toHaveBeenCalledTimes(1)
    expect(cloneImpl).toHaveBeenCalledWith('https://example.com/repo.git', path, [
      '--branch',
      'main',
      '--single-branch'
    ])
  })

  it('is a no-op for from-scratch mode', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'workspace')
    await prefetchWorkspace(fromScratchAgent(path))
    expect(cloneImpl).not.toHaveBeenCalled()
  })

  it('is a no-op (no re-clone, no pull) when a .git checkout already exists', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ac-ws-')), 'co')
    mkdirSync(join(dir, '.git'), { recursive: true })
    await prefetchWorkspace(gitRepoAgent(dir))
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

    const rollback = await prepareWorkspaceForActivation(gitRepoAgent(path))
    const cloneTarget = (cloneImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string
    expect(cloneTarget).not.toBe(path)
    expect(existsSync(join(path, '.git'))).toBe(true)
    expect(existsSync(cloneTarget)).toBe(false)

    rollback()
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(path)).toEqual([])
  })

  it('refuses a non-empty scratch directory without starting a clone', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-convert-')), 'workspace')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'keep.txt'), 'do not overwrite')

    await expect(prepareWorkspaceForActivation(gitRepoAgent(path))).rejects.toThrow('workspace is not empty')
    expect(cloneImpl).not.toHaveBeenCalled()
    expect(existsSync(join(path, 'keep.txt'))).toBe(true)
  })

  it('leaves the original empty directory intact when the staged clone fails', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-convert-')), 'workspace')
    cloneImpl = vi.fn().mockRejectedValue(new Error('clone failed'))

    await expect(prepareWorkspaceForActivation(gitRepoAgent(path))).rejects.toThrow('clone failed')
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(path)).toEqual([])
  })

  it('preserves scratch data that appears while the staged clone is running', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-convert-')), 'workspace')
    cloneImpl = vi.fn().mockImplementation(async (_repo: string, target: string) => {
      mkdirSync(join(target, '.git'), { recursive: true })
      writeFileSync(join(path, 'keep.txt'), 'do not overwrite')
    })

    await expect(prepareWorkspaceForActivation(gitRepoAgent(path))).rejects.toThrow(
      'workspace changed while conversion was cloning'
    )
    expect(existsSync(join(path, 'keep.txt'))).toBe(true)
    expect(existsSync(join(path, '.git'))).toBe(false)
  })

  it('does not accept a checkout that appeared after an initial conversion empty check', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-convert-')), 'workspace')
    mkdirSync(join(path, '.git'), { recursive: true })

    await expect(prepareWorkspaceForActivation(gitRepoAgent(path), { allowExistingCheckout: false })).rejects.toThrow(
      'workspace changed after its empty check'
    )
    expect(cloneImpl).not.toHaveBeenCalled()
  })

  it('preserves local files when repository and branch materialization are unchanged', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-edit-')), 'workspace')
    const current = gitRepoAgent(path)
    mkdirSync(join(path, '.git'), { recursive: true })
    writeFileSync(join(path, 'local.txt'), 'keep me')
    recordWorkspaceMaterialization(current)

    const rollback = await prepareWorkspaceForActivation(
      { ...current, workspace: { ...current.workspace, gitCredential: 'github-app' } } as Agent,
      { reconcileMaterialization: true }
    )

    expect(cloneImpl).not.toHaveBeenCalled()
    expect(existsSync(join(path, 'local.txt'))).toBe(true)
    rollback()
    expect(existsSync(join(path, 'local.txt'))).toBe(true)
  })

  it('preserves a renamed checkout on a later agentDir-only workspace edit', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-edit-')), 'workspace')
    const current = githubAppAgent(path)
    current.workspace.gitRepo = 'https://github.com/acme/old-name'
    mkdirSync(join(path, '.git'), { recursive: true })
    mkdirSync(join(path, 'packages', 'service'), { recursive: true })
    writeFileSync(join(path, 'local.txt'), 'keep me')
    recordWorkspaceMaterialization(current)
    rawMock.mockImplementation(async (args: string[]) =>
      args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/acme/old-name\n' : ''
    )

    const renamed = {
      ...current,
      workspace: { ...current.workspace, gitRepo: 'https://github.com/acme/new-name' }
    } as Agent
    await convergeGithubAppWorkspaceRename(renamed)

    const rollback = await prepareWorkspaceForActivation(
      { ...renamed, workspace: { ...renamed.workspace, agentDir: 'packages/service' } } as Agent,
      { reconcileMaterialization: true }
    )

    expect(rawMock.mock.calls.map((call) => call[0])).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/acme/new-name'
    ])
    expect(cloneImpl).not.toHaveBeenCalled()
    expect(readFileSync(join(path, 'local.txt'), 'utf8')).toBe('keep me')
    rollback()
    expect(readFileSync(join(path, 'local.txt'), 'utf8')).toBe('keep me')
  })

  it('preserves the recorded source across a retry and replaces files when the repository changes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-ws-edit-')), 'workspace')
    const current = gitRepoAgent(path)
    mkdirSync(join(path, '.git'), { recursive: true })
    writeFileSync(join(path, 'local.txt'), 'discard me')
    recordWorkspaceMaterialization(current)
    cloneImpl = vi.fn().mockImplementation(async (_repo: string, target: string) => {
      mkdirSync(join(target, '.git'), { recursive: true })
      writeFileSync(join(target, 'README.md'), 'replacement')
    })
    const target = {
      ...current,
      workspace: { ...current.workspace, gitRepo: 'https://example.com/another.git', gitBranch: 'next' }
    } as Agent
    // A crash can leave the target spec on disk before materialization. The next
    // detach must not overwrite the source marker merely because it sees that spec.
    ensureWorkspaceMaterialization(target)

    const rollback = await prepareWorkspaceForActivation(target, { reconcileMaterialization: true })

    expect(existsSync(join(path, 'local.txt'))).toBe(false)
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('replacement')
    rollback()
    expect(readdirSync(path)).toEqual([])
  })
})

describe('prepareWorkspace repo-local helper re-pin (github-app)', () => {
  beforeEach(() => {
    initGitInjection({
      shimPath: '/run/helper.sh',
      runDir: mkdtempSync(join(tmpdir(), 'ac-ws-gitcred-')),
      preWarm: async () => undefined,
      capabilityFor: (agentId) => `cap-${agentId}`
    })
  })

  it('re-pins an existing checkout to the CURRENT agent id (a recreated agent adopts a stale pin)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ws-repin-'))
    mkdirSync(join(dir, '.git'))

    await prepareWorkspace(githubAppAgent(dir))

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

    await prepareWorkspace(agent)

    expect(rawMock.mock.calls.map((call) => call[0])).toContainEqual(['remote', 'get-url', 'origin'])
    expect(rawMock.mock.calls.map((call) => call[0])).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/acme/new-name'
    ])
    expect(cloneImpl).not.toHaveBeenCalled()
  })

  it('leaves a non-github-app checkout untouched (machine credentials stay machine-managed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ws-repin-'))
    mkdirSync(join(dir, '.git'))

    await prepareWorkspace(gitRepoAgent(dir))

    expect(rawMock).not.toHaveBeenCalled()
  })
})
