import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSchema, type Agent } from '../src/agents/agent-schema.js'
import { createWorkspaceGit } from '../src/cp/workspace-git.js'
import { createWorkspaceReader, WorkspaceViolationError } from '../src/cp/workspace-reader.js'
import { createWorkspaceScope, type WorkspaceScopeSession } from '../src/cp/workspace-scope.js'
import { workspaceGitLocalEnv } from '../src/workspace/git-injection.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'

/**
 * The console's `repo` scope (multi-repository-workspaces.md): every workspace read and git
 * operation follows the secondary root it names, and only a root the agent AUTHORIZES is
 * addressable at all.
 *
 * Against real checkouts, because the claims are about the disk: which directory a listing comes
 * from, which worktree a session's listing comes from, and which remote a pull of that root would
 * reach. The primary must stay byte-identical when the scope is absent.
 */

// One plane per test file — the isolation Vitest's per-file module registry used to give.
const workspaces = new WorkspaceManager()

const AGENT = 'bot-repos'
const AUTHORIZED = 'acme/infra'
const AUTHORIZED_ID = '4242'
// Authorized but never materialized: no checkout on disk, so it reads as an empty workspace.
const UNMATERIALIZED = 'example-co/shared-library'
const SESSION_KEY = 'slack:C1:1700000000.000100'
const ACP_SESSION = 'acp-session-1'

const env = {
  ...workspaceGitLocalEnv(),
  GIT_AUTHOR_NAME: 'Ada Lovelace',
  GIT_AUTHOR_EMAIL: 'ada@example.invalid',
  GIT_COMMITTER_NAME: 'Ada Lovelace',
  GIT_COMMITTER_EMAIL: 'ada@example.invalid'
}
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { env, stdio: 'ignore' })

let base: string
let agentDir: string
let agent: Agent
let secondaryCheckout: string
let secondaryWorktree: string
let scope: ReturnType<typeof createWorkspaceScope>
let reader: ReturnType<typeof createWorkspaceReader>
let seam: ReturnType<typeof createWorkspaceGit>

/** An isolated session, so a `sessionId` selects each root's own worktree. */
const isolatedSession: WorkspaceScopeSession = { key: SESSION_KEY, workspaceIsolation: 'session' }

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ac-repo-scope-'))
  agentDir = join(base, 'agents', AGENT)
  const primary = join(agentDir, 'workspace')
  mkdirSync(primary, { recursive: true })
  // Present ONLY in the primary: an answer naming it proves the wrong root was read.
  writeFileSync(join(primary, 'PRIMARY-ONLY.md'), 'the agent workspace\n')

  agent = AgentSchema.parse({
    id: AGENT,
    name: AGENT,
    status: 'active',
    runtime: 'claude',
    workspace: {
      mode: 'from-scratch',
      path: primary,
      additionalRepos: [
        { repoFullName: AUTHORIZED, repoId: AUTHORIZED_ID },
        { repoFullName: UNMATERIALIZED, repoId: '815' }
      ]
    },
    integrations: [],
    output: { mode: 'low' }
  })

  const subtree = join(agentDir, 'repos', ...AUTHORIZED.split('/'))
  secondaryCheckout = join(subtree, 'checkout')
  mkdirSync(secondaryCheckout, { recursive: true })
  git(secondaryCheckout, 'init', '-b', 'trunk')
  writeFileSync(join(secondaryCheckout, 'SECONDARY-ONLY.md'), 'the additional repository\n')
  git(secondaryCheckout, 'add', '-A')
  git(secondaryCheckout, 'commit', '-m', 'feat: the secondary root')
  // The branch is NOT projected by the control plane — the root's own attestation is what knows it.
  writeFileSync(
    join(subtree, '.materialization.json'),
    JSON.stringify({ repoId: AUTHORIZED_ID, repoFullName: AUTHORIZED, branch: 'trunk' }, null, 2)
  )

  // Isolation applies to every root uniformly, so this worktree carries the primary's session id.
  secondaryWorktree = join(subtree, 'worktrees', workspaces.sessionWorktreeId(SESSION_KEY))
  git(secondaryCheckout, 'worktree', 'add', '-q', '-b', 'dev/ada/session', secondaryWorktree)
  writeFileSync(join(secondaryWorktree, 'WORKTREE-ONLY.md'), 'this session only\n')

  scope = createWorkspaceScope({
    workspaces,
    agentOf: (id) => (id === AGENT ? agent : undefined),
    sessionOf: async (_id, acpSessionId) => (acpSessionId === ACP_SESSION ? isolatedSession : undefined),
    runtimeRootOf: () => undefined
  })
  reader = createWorkspaceReader(workspaces, scope.location, (_id, write) => write())
  seam = createWorkspaceGit(workspaces, scope.gitRoot, () => ({}), scope.target)
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

const names = (entries: { name: string }[]) => entries.map((entry) => entry.name).sort()

describe('workspace reads follow the repo scope', () => {
  it('lists the primary workspace when no repo is named', async () => {
    const page = await reader.list({ agentId: AGENT, path: '', limit: 50 })
    expect(names(page.entries)).toEqual(['PRIMARY-ONLY.md'])
  })

  it('lists and reads the named secondary root’s checkout', async () => {
    const page = await reader.list({ agentId: AGENT, repo: AUTHORIZED, path: '', limit: 50 })
    expect(names(page.entries)).toEqual(['SECONDARY-ONLY.md'])
    expect(
      await reader.read({ agentId: AGENT, repo: AUTHORIZED, path: 'SECONDARY-ONLY.md', offset: 0, limit: 65_536 })
    ).toMatchObject({ exists: true, content: 'the additional repository\n' })
  })

  it('matches the repository name case-insensitively, like every other repo full name', async () => {
    const page = await reader.list({ agentId: AGENT, repo: 'ACME/Infra', path: '', limit: 50 })
    expect(names(page.entries)).toEqual(['SECONDARY-ONLY.md'])
  })

  it('lists that root’s OWN per-session worktree when a session is named too', async () => {
    const page = await reader.list({
      agentId: AGENT,
      repo: AUTHORIZED,
      sessionId: ACP_SESSION,
      path: '',
      limit: 50
    })
    expect(names(page.entries)).toEqual(['SECONDARY-ONLY.md', 'WORKTREE-ONLY.md'])
  })

  it('refuses a session that is not isolated, exactly as the primary does', async () => {
    const shared = createWorkspaceScope({
      workspaces,
      agentOf: (id) => (id === AGENT ? agent : undefined),
      sessionOf: async () => ({ key: SESSION_KEY, workspaceIsolation: 'shared' }),
      runtimeRootOf: () => undefined
    })
    await expect(shared.location(AGENT, ACP_SESSION, AUTHORIZED)).resolves.toBeUndefined()
  })

  it('answers an authorized-but-unmaterialized root as an absent directory, never an error', async () => {
    const page = await reader.list({ agentId: AGENT, repo: UNMATERIALIZED, path: '', limit: 50 })
    expect(page).toMatchObject({ exists: false, entries: [] })
    expect(
      await reader.read({ agentId: AGENT, repo: UNMATERIALIZED, path: 'README.md', offset: 0, limit: 65_536 })
    ).toMatchObject({ exists: false })
  })

  it('refuses a repository the agent does not authorize', async () => {
    await expect(reader.list({ agentId: AGENT, repo: 'acme/not-granted', path: '', limit: 50 })).rejects.toMatchObject({
      reason: 'unknown-agent'
    })
    await expect(reader.list({ agentId: AGENT, repo: 'acme/not-granted', path: '', limit: 50 })).rejects.toBeInstanceOf(
      WorkspaceViolationError
    )
  })

  it('keeps file edits on the primary: the write frames carry no repo scope', async () => {
    await reader.write({ agentId: AGENT, path: 'notes.md', contentBase64: Buffer.from('hi\n').toString('base64') })
    expect(readFileSync(join(agentDir, 'workspace', 'notes.md'), 'utf8')).toBe('hi\n')
  })
})

describe('workspace git follows the repo scope', () => {
  it('reports the secondary root’s branch and commit, where the scratch primary is not a repo', async () => {
    expect(await seam.status(AGENT)).toMatchObject({ isRepo: false })
    const status = await seam.status(AGENT, undefined, AUTHORIZED)
    expect(status).toMatchObject({ isRepo: true, branch: 'trunk' })
    expect(status.lastCommit?.subject).toBe('feat: the secondary root')
  })

  it('reports the session worktree’s own branch under the same scope', async () => {
    expect(await seam.status(AGENT, ACP_SESSION, AUTHORIZED)).toMatchObject({
      isRepo: true,
      branch: 'dev/ada/session'
    })
  })

  it('logs and diffs the secondary root', async () => {
    const log = await seam.log({ agentId: AGENT, repo: AUTHORIZED, limit: 20 })
    expect(log.commits.map((commit) => commit.subject)).toEqual(['feat: the secondary root'])
    writeFileSync(join(secondaryCheckout, 'SECONDARY-ONLY.md'), 'edited\n')
    const diff = await seam.diff({ agentId: AGENT, repo: AUTHORIZED, path: 'SECONDARY-ONLY.md', staged: false })
    expect(diff).toMatchObject({ isRepo: true, exists: true })
    expect(diff.diff).toContain('+edited')
    writeFileSync(join(secondaryCheckout, 'SECONDARY-ONLY.md'), 'the additional repository\n')
  })

  it('targets the secondary repository’s own remote and attested branch, not the primary’s', () => {
    const target = scope.target(AGENT, AUTHORIZED)
    expect(target).toMatchObject({ branch: 'trunk', githubApp: true })
    expect(target?.repo).toContain(AUTHORIZED)
    // A scratch primary has no clone at all, which is exactly what a pull of it must keep answering.
    expect(scope.target(AGENT)).toBeUndefined()
  })

  it('refuses to pull a checkout whose origin is not that repository’s', async () => {
    // The secondary checkout has no origin at all, so the authorized-target check must decline
    // rather than fall back to the primary workspace's remote.
    expect(await seam.pull(AGENT, AUTHORIZED)).toMatchObject({
      isRepo: true,
      ok: false,
      detail: 'workspace origin is not a safe remote'
    })
  })

  it('refuses a repository the agent does not authorize', async () => {
    await expect(seam.status(AGENT, undefined, 'acme/not-granted')).rejects.toBeInstanceOf(WorkspaceViolationError)
  })
})

describe('cluster daemons have nowhere to put a secondary root yet', () => {
  it('answers no root for a repo scope in sandbox mode, instead of serving the primary', async () => {
    workspaces.setSandboxMode(true)
    try {
      await expect(scope.location(AGENT, undefined, AUTHORIZED)).resolves.toBeUndefined()
      // The primary is unaffected: it still resolves to the sandbox checkout.
      await expect(scope.location(AGENT)).resolves.toBeDefined()
    } finally {
      workspaces.setSandboxMode(false)
    }
  })
})
