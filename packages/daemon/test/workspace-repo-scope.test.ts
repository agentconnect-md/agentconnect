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
import { PodWorkspaceFs } from './fixtures/pod-workspace-fs.js'

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
  seam = createWorkspaceGit(workspaces, scope.gitRoot, () => undefined, scope.target)
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

  it('targets the secondary repository’s own remote and attested branch, not the primary’s', async () => {
    const target = await scope.target(AGENT, AUTHORIZED)
    expect(target).toMatchObject({ branch: 'trunk', githubApp: true })
    expect(target?.repo).toContain(AUTHORIZED)
    // A scratch primary has no clone at all, which is exactly what a pull of it must keep answering.
    await expect(scope.target(AGENT)).resolves.toBeUndefined()
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

describe('a secondary root is App-covered whatever the primary workspace is', () => {
  it('marks the root App-backed for a MANUAL GitHub primary, whose own clone is anonymous', async () => {
    // A manual GitHub workspace may explicitly authorize its own App-covered repositories. Deriving
    // the credential decision from the PRIMARY's mode would leave those roots' private clones
    // anonymous; the scope's target is what says which credentials each root needs.
    const manual = AgentSchema.parse({
      id: 'bot-manual',
      name: 'bot-manual',
      status: 'active',
      runtime: 'claude',
      workspace: {
        mode: 'git-repo',
        path: join(base, 'agents', 'bot-manual', 'workspace'),
        gitRepo: 'https://github.com/example-co/manual-checkout',
        additionalRepos: [{ repoFullName: AUTHORIZED, repoId: AUTHORIZED_ID }]
      },
      integrations: [],
      output: { mode: 'low' }
    })
    const manualScope = createWorkspaceScope({
      workspaces,
      agentOf: (id) => (id === 'bot-manual' ? manual : undefined),
      sessionOf: async () => undefined,
      runtimeRootOf: () => undefined
    })
    await expect(manualScope.target('bot-manual')).resolves.toMatchObject({ githubApp: false })
    await expect(manualScope.target('bot-manual', AUTHORIZED)).resolves.toMatchObject({ githubApp: true, branch: '' })
    expect(manualScope.usesGithubApp('bot-manual')).toBe(false)
    expect(manualScope.usesGithubApp('bot-manual', AUTHORIZED)).toBe(true)
  })
})

describe('the console git scope keys on the MANAGED credential, not the github-app value', () => {
  // A real checkout whose `origin` IS the managed URL, with `origin/main` already at HEAD: a push
  // then settles on the ahead-0 shortcut, which is reached only when authorizedTarget answered AND
  // its origin equals the checkout's own — so it pins the authorized URL without any network.
  const checkoutOn = (name: string, origin: string): string => {
    const dir = join(base, 'agents', name, 'workspace')
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-b', 'main')
    writeFileSync(join(dir, 'README.md'), 'the managed primary\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'feat: the managed primary')
    git(dir, 'remote', 'add', 'origin', origin)
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(dir, 'branch', '--set-upstream-to=origin/main', 'main')
    return dir
  }

  const managed = (id: string, path: string, gitRepo: string, gitCredential: 'github-app' | 'gitlab'): Agent =>
    AgentSchema.parse({
      id,
      name: id,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'git-repo', path, gitRepo, gitCredential },
      integrations: [],
      output: { mode: 'low' }
    })

  const seamOn = (agentRow: Agent) => {
    const managedScope = createWorkspaceScope({
      workspaces,
      agentOf: (id) => (id === agentRow.id ? agentRow : undefined),
      sessionOf: async () => undefined,
      runtimeRootOf: () => undefined
    })
    return createWorkspaceGit(workspaces, managedScope.gitRoot, () => undefined, managedScope.target)
  }

  it('rides the helper for a gitlab primary, whose target host the remote builder derives from the URL', async () => {
    const gitlab = AgentSchema.parse({
      id: 'bot-gitlab',
      name: 'bot-gitlab',
      status: 'active',
      runtime: 'claude',
      workspace: {
        mode: 'git-repo',
        path: join(base, 'agents', 'bot-gitlab', 'workspace'),
        gitRepo: 'https://gitlab.com/example-group/example-project',
        gitCredential: 'gitlab',
        gitlabProjectId: '4455667'
      },
      integrations: [],
      output: { mode: 'low' }
    })
    const gitlabScope = createWorkspaceScope({
      workspaces,
      agentOf: (id) => (id === 'bot-gitlab' ? gitlab : undefined),
      sessionOf: async () => undefined,
      runtimeRootOf: () => undefined
    })
    await expect(gitlabScope.target('bot-gitlab')).resolves.toMatchObject({
      repo: 'https://gitlab.com/example-group/example-project',
      githubApp: true
    })
    expect(gitlabScope.usesGithubApp('bot-gitlab')).toBe(true)
  })

  it('leaves an anonymous git-repo primary off the helper, so the flag still means something', async () => {
    const anon = AgentSchema.parse({
      id: 'bot-anon',
      name: 'bot-anon',
      status: 'active',
      runtime: 'claude',
      workspace: {
        mode: 'git-repo',
        path: join(base, 'agents', 'bot-anon', 'workspace'),
        gitRepo: 'https://gitlab.com/example-group/public-project'
      },
      integrations: [],
      output: { mode: 'low' }
    })
    const anonScope = createWorkspaceScope({
      workspaces,
      agentOf: (id) => (id === 'bot-anon' ? anon : undefined),
      sessionOf: async () => undefined,
      runtimeRootOf: () => undefined
    })
    await expect(anonScope.target('bot-anon')).resolves.toMatchObject({ githubApp: false })
    expect(anonScope.usesGithubApp('bot-anon')).toBe(false)
  })

  it('authorizes a gitlab SUBGROUP primary at its configured URL, which github canonicalization throws on', async () => {
    // Three path segments: `normalizeGithubRepoUrl` demands owner/repo and throws, which used to refuse every console push.
    const configured = 'https://gitlab.com/example-group/sub/example-project'
    // The checkout carries what the daemon clones through — the canonical `.git` remote.
    const row = managed('bot-gitlab-push', checkoutOn('bot-gitlab-push', `${configured}.git`), configured, 'gitlab')
    expect(await seamOn(row).push({ agentId: row.id })).toMatchObject({ isRepo: true, ok: true, ahead: 0 })
  })

  it('dials a managed gitlab primary through the canonical `.git` remote, github byte-identically', () => {
    // gitlab.com 301s the suffix-less ref probe and daemon Git refuses to follow one — the first real managed clone died on it.
    const at = (id: string) => join(base, 'agents', id, 'workspace')
    const bare = managed('bot-gl-bare', at('bot-gl-bare'), 'https://gitlab.com/example-group/example-project', 'gitlab')
    expect(workspaces.gitRepoOf(bare)).toBe('https://gitlab.com/example-group/example-project.git')
    expect(workspaces.primaryRoot(bare).cloneUrl).toBe('https://gitlab.com/example-group/example-project.git')

    const subgroup = managed('bot-gl-sub', at('bot-gl-sub'), 'https://gitlab.com/example-group/sub/proj', 'gitlab')
    expect(workspaces.primaryRoot(subgroup).cloneUrl).toBe('https://gitlab.com/example-group/sub/proj.git')

    const suffixed = managed('bot-gl-suffixed', at('bot-gl-suffixed'), 'https://gitlab.com/g/p.git', 'gitlab')
    expect(workspaces.primaryRoot(suffixed).cloneUrl).toBe('https://gitlab.com/g/p.git')

    const github = managed('bot-gh-clone', at('bot-gh-clone'), 'https://github.com/acme/infra', 'github-app')
    expect(workspaces.primaryRoot(github).cloneUrl).toBe('https://github.com/acme/infra')
  })

  it('converges a checkout left on the suffix-less origin, so the agent never sees a second form', async () => {
    // The origin the AGENT's git reads must be the one the daemon dials; convergence at reconcile and prepare is that seam.
    const configured = 'https://gitlab.com/example-group/example-project'
    const dir = checkoutOn('bot-gl-converge', configured)
    const row = managed('bot-gl-converge', dir, configured, 'gitlab')
    await workspaces.convergeOriginInPlaceFor(row.id, workspaces.primaryRoot(row), dir)
    const origin = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { env, encoding: 'utf8' }).trim()
    expect(origin).toBe(`${configured}.git`)
  })

  it('keeps the materialization key suffix-insensitive, so canonicalizing does not re-clone a checkout', () => {
    // The key decides whether a checkout still matches the config, so gaining `.git` must not empty a materialized volume.
    const at = (id: string) => join(base, 'agents', id, 'workspace')
    const bare = managed('bot-gl-key', at('bot-gl-key'), 'https://gitlab.com/example-group/example-project', 'gitlab')
    const suffixed = managed(
      'bot-gl-key2',
      at('bot-gl-key'),
      'https://gitlab.com/example-group/example-project.git',
      'gitlab'
    )
    expect(workspaces.materializationKey(bare)).toBe(workspaces.materializationKey(suffixed))
    expect(workspaces.materializationKey(bare)).toContain('https://gitlab.com/example-group/example-project"')
  })

  it('still collapses a github-app primary onto its canonical owner/repo origin', async () => {
    // A host-shifted configured URL: collapsing it is what keeps the App grant's authority pinned to
    // github.com, so the provider split must not cost github that canonicalization.
    const dir = checkoutOn('bot-github-push', 'https://github.com/acme/canonical')
    const row = managed('bot-github-push', dir, 'https://code.example.test/acme/canonical', 'github-app')
    expect(await seamOn(row).push({ agentId: row.id })).toMatchObject({ isRepo: true, ok: true, ahead: 0 })
  })
})

// Pod coordinates are POSIX by construction — the sandbox pod is always Linux.
describe.skipIf(process.platform === 'win32')('a cluster daemon addresses a secondary root on the pod volume', () => {
  const POD_ROOT = '/agent'
  const POD_SECONDARY = `${POD_ROOT}/repos/${AUTHORIZED}`

  it('resolves the checkout, its session worktree and the attested branch in pod coordinates', async () => {
    const pod = new PodWorkspaceFs(POD_ROOT, `${POD_SECONDARY}/checkout`, `${POD_SECONDARY}/worktrees`)
    pod.files.set(
      `${POD_SECONDARY}/.materialization.json`,
      JSON.stringify({ repoId: AUTHORIZED_ID, repoFullName: AUTHORIZED, branch: 'pod-trunk' })
    )
    workspaces.setSandboxMode(true)
    workspaces.setFsResolver(() => ({ fs: pod, mount: POD_ROOT }))
    const podScope = createWorkspaceScope({
      workspaces,
      agentOf: (id) => (id === AGENT ? agent : undefined),
      sessionOf: async (_agentId, acpSessionId) =>
        acpSessionId === 'acp-iso' ? { key: 'iso-key', workspaceIsolation: 'session' } : undefined,
      runtimeRootOf: () => POD_ROOT
    })
    try {
      await expect(podScope.location(AGENT, undefined, AUTHORIZED)).resolves.toMatchObject({
        root: `${POD_SECONDARY}/checkout`,
        scratch: false
      })
      const worktree = await podScope.location(AGENT, 'acp-iso', AUTHORIZED)
      expect(worktree?.root).toBe(`${POD_SECONDARY}/worktrees/${workspaces.sessionWorktreeId('iso-key')}`)
      // The branch comes from the marker ON THE VOLUME, read through the seam — never this disk.
      await expect(podScope.target(AGENT, AUTHORIZED)).resolves.toMatchObject({ branch: 'pod-trunk', githubApp: true })
      // The primary still resolves to the sandbox checkout, untouched by the repo scope.
      await expect(podScope.location(AGENT)).resolves.toBeDefined()
    } finally {
      workspaces.setFsResolver(undefined)
      workspaces.setSandboxMode(false)
    }
  })
})
