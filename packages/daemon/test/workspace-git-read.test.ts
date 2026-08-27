import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { createWorkspaceGit } from '../src/cp/workspace-git.js'
import { WorkspaceViolationError } from '../src/cp/workspace-reader.js'
import { gitFor, workspaceGitLocalEnv } from '../src/workspace/git-injection.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'

// One plane per test file — the isolation Vitest's per-file module registry used to give.
const workspaces = new WorkspaceManager()
import { LocalGitRunner } from '../src/workspace/git-runner.js'

// The seam's git reads against a REAL repository: the mocked-simple-git suite
// (workspace-git.test.ts) can prove the mapping, only actual `git` output can prove
// the numstat / unified-diff / log formats the parsers were written against.
const AGENT = 'bot-a'

const env = {
  ...workspaceGitLocalEnv(),
  GIT_AUTHOR_NAME: 'Ada Lovelace',
  GIT_AUTHOR_EMAIL: 'ada@example.invalid',
  GIT_COMMITTER_NAME: 'Ada Lovelace',
  GIT_COMMITTER_EMAIL: 'ada@example.invalid'
}
// No background maintenance: `git commit` detaches `maintenance run --auto` (git >= 2.47), and that
// child's objects/maintenance.lock teardown races this file's fixture surgery and afterAll sweep.
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    env,
    stdio: 'ignore'
  })

let base: string
let repo: string // a real checkout with an upstream ref and one unpushed commit
let scratch: string // a from-scratch (no .git) workspace
let seam: ReturnType<typeof createWorkspaceGit>

const lines = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag}-${i}\n`).join('')

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ac-git-read-'))
  repo = join(base, 'repo')
  scratch = join(base, 'scratch')
  mkdirSync(repo, { recursive: true })
  mkdirSync(scratch, { recursive: true })

  git(repo, 'init', '-b', 'main')
  writeFileSync(join(repo, 'keep.txt'), lines(10, 'keep'))
  writeFileSync(join(repo, 'rename-me.txt'), 'old\n')
  writeFileSync(join(repo, "sp ace'q.txt"), 'space\n')
  writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
  writeFileSync(join(repo, 'unchanged.txt'), 'still here\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'first commit')

  // The upstream ref, without a network: the first commit is "pushed", the second is not.
  // `@{upstream}` needs the remote to exist for its fetch refspec, so declare one — it is
  // never contacted (the seam runs with GIT_ALLOW_PROTOCOL='').
  git(repo, 'remote', 'add', 'origin', join(base, 'unreachable-remote'))
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'config', 'branch.main.remote', 'origin')
  git(repo, 'config', 'branch.main.merge', 'refs/heads/main')
  writeFileSync(join(repo, 'keep.txt'), lines(10, 'keep') + 'committed line\n')
  git(repo, 'commit', '-am', 'second commit: the unpushed one')

  // The working tree the console reads: staged + unstaged + a rename + a binary + untracked.
  writeFileSync(join(repo, 'keep.txt'), lines(9, 'keep') + 'committed line\nstaged addition\n')
  git(repo, 'add', 'keep.txt')
  writeFileSync(join(repo, 'keep.txt'), lines(9, 'keep') + 'committed line\nstaged addition\nunstaged addition\n')
  git(repo, 'mv', 'rename-me.txt', 'renamed.txt')
  writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x08, 0x07]))
  git(repo, 'add', 'logo.png')
  writeFileSync(join(repo, 'untracked.txt'), 'brand new\n')

  seam = createWorkspaceGit(workspaces, async (agentId) =>
    agentId === AGENT ? repo : agentId === 'scratch-agent' ? scratch : undefined
  )
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('createWorkspaceGit.status against a real repo', () => {
  it('joins per-file numstat counts vs HEAD (staged AND unstaged in one pair)', async () => {
    const s = await seam.status(AGENT)
    const byPath = new Map(s.files!.map((f) => [f.path, f]))
    // keep.txt: one committed line kept, one line dropped, two added — counts are vs HEAD,
    // so they cover the staged AND the unstaged edit rather than one of the two.
    expect(byPath.get('keep.txt')).toEqual({
      path: 'keep.txt',
      index: 'M',
      workingDir: 'M',
      additions: 2,
      deletions: 1
    })
  })

  it('reports a rename under the path git status uses, with its counts', async () => {
    const s = await seam.status(AGENT)
    const renamed = s.files!.find((f) => f.path === 'renamed.txt')
    expect(renamed).toMatchObject({ path: 'renamed.txt', additions: 0, deletions: 0 })
    expect(s.files!.some((f) => f.path === 'rename-me.txt')).toBe(false)
  })

  it('omits counts for a binary change and for an untracked file', async () => {
    const s = await seam.status(AGENT)
    const byPath = new Map(s.files!.map((f) => [f.path, f]))
    expect(byPath.get('logo.png')?.additions).toBeUndefined()
    expect(byPath.get('logo.png')?.deletions).toBeUndefined()
    expect(byPath.get('untracked.txt')).toEqual({ path: 'untracked.txt', index: '?', workingDir: '?' })
  })
})

describe('createWorkspaceGit.diff against a real repo', () => {
  it('returns unified-diff text for the unstaged change, with hunk headers intact', async () => {
    const d = await seam.diff({ agentId: AGENT, path: 'keep.txt', staged: false })
    expect(d).toMatchObject({ agentId: AGENT, path: 'keep.txt', isRepo: true, exists: true })
    expect(d.diff).toContain('--- a/keep.txt')
    expect(d.diff).toContain('+++ b/keep.txt')
    expect(d.diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m)
    expect(d.diff).toContain('+unstaged addition')
    expect(d.diff).not.toContain('+staged addition') // already in the index ⇒ not in this scope
    expect(d.truncated).toBeUndefined()
    expect(d.binary).toBeUndefined()
  })

  it('answers a different diff for the staged scope', async () => {
    const d = await seam.diff({ agentId: AGENT, path: 'keep.txt', staged: true })
    expect(d.diff).toContain('+staged addition')
    expect(d.diff).not.toContain('+unstaged addition')
  })

  it('reports a binary change as binary:true with no diff text', async () => {
    const d = await seam.diff({ agentId: AGENT, path: 'logo.png', staged: true })
    expect(d).toEqual({ agentId: AGENT, path: 'logo.png', isRepo: true, exists: true, binary: true })
  })

  it('an unchanged path is DATA: exists, no diff, not binary', async () => {
    const d = await seam.diff({ agentId: AGENT, path: 'unchanged.txt', staged: false })
    expect(d).toEqual({ agentId: AGENT, path: 'unchanged.txt', isRepo: true, exists: true })
  })

  it('a path this checkout does not have is DATA: exists:false', async () => {
    const d = await seam.diff({ agentId: AGENT, path: 'no/such/file.ts', staged: false })
    expect(d).toEqual({ agentId: AGENT, path: 'no/such/file.ts', isRepo: true, exists: false })
  })

  it('a tracked file deleted from the worktree still has a diff (exists is about the CHANGE)', async () => {
    // Its own repo: a commit in the shared fixture would move what the log tests read.
    const doomed = join(base, 'doomed')
    mkdirSync(doomed, { recursive: true })
    git(doomed, 'init', '-b', 'main')
    writeFileSync(join(doomed, 'doomed.txt'), 'here for now\n')
    git(doomed, 'add', '-A')
    git(doomed, 'commit', '-m', 'add doomed.txt')
    rmSync(join(doomed, 'doomed.txt'))
    const d = await createWorkspaceGit(workspaces, async () => doomed).diff({
      agentId: AGENT,
      path: 'doomed.txt',
      staged: false
    })
    expect(d.exists).toBe(true) // the path is gone from disk, but its CHANGE is what was asked for
    expect(d.diff).toContain('-here for now')
  })

  it('an untracked file has no diff in either scope (the console opens it as a file)', async () => {
    const d = await seam.diff({ agentId: AGENT, path: 'untracked.txt', staged: false })
    expect(d).toEqual({ agentId: AGENT, path: 'untracked.txt', isRepo: true, exists: true })
  })

  it('a directory path diffs its subtree', async () => {
    mkdirSync(join(repo, 'sub'), { recursive: true })
    writeFileSync(join(repo, 'sub', 'one.txt'), 'one\n')
    writeFileSync(join(repo, 'sub', 'two.txt'), 'two\n')
    git(repo, 'add', 'sub')
    const d = await seam.diff({ agentId: AGENT, path: 'sub', staged: true })
    expect(d.exists).toBe(true)
    expect(d.diff).toContain('+one')
    expect(d.diff).toContain('+two')
  })

  it('a from-scratch workspace is DATA: isRepo:false', async () => {
    const d = await seam.diff({ agentId: 'scratch-agent', path: 'notes.md', staged: false })
    expect(d).toEqual({ agentId: 'scratch-agent', path: 'notes.md', isRepo: false, exists: false })
  })

  it('names a path containing a space and a quote exactly (no c-style requoting)', async () => {
    writeFileSync(join(repo, "sp ace'q.txt"), 'space\nmore\n')
    const d = await seam.diff({ agentId: AGENT, path: "sp ace'q.txt", staged: false })
    expect(d.exists).toBe(true)
    expect(d.diff).toContain('+more')
  })

  // Needs a file literally named `*.ts`, which Windows cannot create.
  it.skipIf(process.platform === 'win32')(
    'treats a pathspec-magic-looking path as a literal name, not a pattern',
    async () => {
      // `:(literal)` is why a file literally called `*.ts` cannot widen the diff to
      // every .ts file in the checkout.
      writeFileSync(join(repo, '*.ts'), 'glob-named file\n')
      writeFileSync(join(repo, 'real.ts'), 'a real typescript file\n')
      git(repo, 'add', '--', ':(literal)*.ts', 'real.ts')
      const d = await seam.diff({ agentId: AGENT, path: '*.ts', staged: true })
      expect(d.exists).toBe(true)
      expect(d.diff).toContain('+glob-named file')
      expect(d.diff).not.toContain('real.ts') // the pattern would have swept this in
    }
  )

  it('truncates a diff bigger than the frame budget and keeps the REP under the wire cap', async () => {
    // ~2 MB of added lines: far past the 256 KiB frame, so the head slice is what ships.
    writeFileSync(join(repo, 'huge.txt'), lines(80_000, 'a-line-of-text-that-adds-up'))
    git(repo, 'add', 'huge.txt')
    const d = await seam.diff({ agentId: AGENT, path: 'huge.txt', staged: true })
    expect(d.truncated).toBe(true)
    expect(d.diff!.length).toBeGreaterThan(1000) // a real head slice, not an empty answer
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(MAX_FRAME_BYTES)
  })

  it('refuses a path escaping the workspace, an absolute path, and git internals', async () => {
    await expect(seam.diff({ agentId: AGENT, path: '../secret.env', staged: false })).rejects.toBeInstanceOf(
      WorkspaceViolationError
    )
    await expect(seam.diff({ agentId: AGENT, path: '/etc/passwd', staged: false })).rejects.toBeInstanceOf(
      WorkspaceViolationError
    )
    await expect(seam.diff({ agentId: AGENT, path: '.git/config', staged: false })).rejects.toMatchObject({
      reason: 'git-internals'
    })
    await expect(seam.diff({ agentId: 'nope', path: 'keep.txt', staged: false })).rejects.toMatchObject({
      reason: 'unknown-agent'
    })
  })

  it('is not an existence oracle for host paths behind a symlinked directory', async () => {
    // Lexical containment passes for `vendor/x` while the real path resolves out of the
    // workspace, and `lstat` follows intermediate components — so answering `exists` off the
    // filesystem turned this read into a true/false probe for arbitrary host paths. The
    // canonical check is the same one `workspace/read` applies; the two seams must agree.
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'HOST_SECRET.env'), 'token=abc\n')
    symlinkSync(outside, join(repo, 'vendor'), 'dir')

    await expect(seam.diff({ agentId: AGENT, path: 'vendor/HOST_SECRET.env', staged: false })).rejects.toMatchObject({
      reason: 'path-escape'
    })
    // The absent sibling must not answer differently — that difference IS the oracle.
    await expect(seam.diff({ agentId: AGENT, path: 'vendor/NOPE.env', staged: false })).rejects.toMatchObject({
      reason: 'path-escape'
    })
  })
})

describe('createWorkspaceGit.log against a real repo', () => {
  it('returns commits newest-first with the upstream ref it marked them against', async () => {
    const l = await seam.log({ agentId: AGENT, limit: 20 })
    expect(l.isRepo).toBe(true)
    expect(l.tracking).toBe('origin/main')
    expect(l.commits.map((c) => c.subject)).toEqual(['second commit: the unpushed one', 'first commit'])
    expect(l.commits[0]!.author).toBe('Ada Lovelace')
    expect(l.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(l.commits[0]!.shortSha).toBe(l.commits[0]!.sha.slice(0, l.commits[0]!.shortSha.length))
    // RFC3339, which allows either a numeric offset or `Z` — git's `%cI` renders a zero
    // offset one way on some builds and the other on others, and the wire contract does not
    // care which. Assert the contract (parseable instant) rather than the local rendering.
    expect(l.commits[0]!.committedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:[+-]\d\d:\d\d|Z)$/)
    expect(Number.isNaN(Date.parse(l.commits[0]!.committedAt))).toBe(false)
    expect(l.truncated).toBe(false)
  })

  it('marks the commit the upstream ref does not contain as unpushed', async () => {
    const l = await seam.log({ agentId: AGENT, limit: 20 })
    expect(l.commits.map((c) => c.pushed)).toEqual([false, true])
  })

  it('truncates at the requested limit', async () => {
    const l = await seam.log({ agentId: AGENT, limit: 1 })
    expect(l.commits).toHaveLength(1)
    expect(l.commits[0]!.subject).toBe('second commit: the unpushed one')
    expect(l.truncated).toBe(true)
  })

  // A session worktree checks out its own `dev/<user>/<words>` from `refs/remotes/origin/<base>`,
  // so the answer a reader wants there is what the BRANCH adds — the base branch's newest commit is
  // not this session's work. The exclusion is asked of the configured branch only, and only when HEAD
  // is some other branch, so the agent's primary checkout keeps its full history.
  describe('the range one checkout is measured over', () => {
    const target = { repo: 'https://github.com/acme/api.git', branch: 'main', githubApp: false }
    let branched: string

    beforeAll(() => {
      branched = join(base, 'branched')
      mkdirSync(branched, { recursive: true })
      git(branched, 'init', '-b', 'main')
      writeFileSync(join(branched, 'a.txt'), 'a\n')
      git(branched, 'add', '-A')
      git(branched, 'commit', '-m', 'base: already on main')
      git(branched, 'remote', 'add', 'origin', join(base, 'unreachable-remote'))
      git(branched, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      git(branched, 'checkout', '-q', '-b', 'dev/jane-doe/candid-lynx')
      writeFileSync(join(branched, 'b.txt'), 'b\n')
      git(branched, 'add', '-A')
      git(branched, 'commit', '-m', 'the session’s own work')
    })

    const seamFor = (root: string) =>
      createWorkspaceGit(
        workspaces,
        async () => root,
        () => undefined,
        async () => target
      )

    it('lists only what the checked-out branch adds over the configured base, and names it', async () => {
      const l = await seamFor(branched).log({ agentId: AGENT, limit: 20 })
      expect(l.base).toBe('origin/main')
      expect(l.commits.map((c) => c.subject)).toEqual(['the session’s own work'])
    })

    it('keeps the whole history on the base branch itself — there is nothing to exclude there', async () => {
      git(branched, 'checkout', '-q', 'main')
      try {
        const l = await seamFor(branched).log({ agentId: AGENT, limit: 20 })
        expect(l.base).toBeUndefined()
        expect(l.commits.map((c) => c.subject)).toEqual(['base: already on main'])
      } finally {
        git(branched, 'checkout', '-q', 'dev/jane-doe/candid-lynx')
      }
    })

    it('falls back to the whole history when the base ref is not in this checkout', async () => {
      // A never-fetched base: `<missing>..HEAD` would fail the read outright, so the exclusion is dropped.
      const unfetched = join(base, 'unfetched')
      mkdirSync(unfetched, { recursive: true })
      git(unfetched, 'init', '-b', 'work')
      writeFileSync(join(unfetched, 'a.txt'), 'a\n')
      git(unfetched, 'add', '-A')
      git(unfetched, 'commit', '-m', 'only commit')
      const l = await seamFor(unfetched).log({ agentId: AGENT, limit: 20 })
      expect(l.base).toBeUndefined()
      expect(l.commits.map((c) => c.subject)).toEqual(['only commit'])
    })
  })

  it('a branch that tracks nothing reports no tracking ref and nothing pushed', async () => {
    const orphan = join(base, 'orphan')
    mkdirSync(orphan, { recursive: true })
    git(orphan, 'init', '-b', 'main')
    writeFileSync(join(orphan, 'a.txt'), 'a\n')
    git(orphan, 'add', '-A')
    git(orphan, 'commit', '-m', 'only commit')
    const l = await createWorkspaceGit(workspaces, async () => orphan).log({ agentId: AGENT, limit: 20 })
    expect(l.tracking).toBeUndefined()
    expect(l.commits).toHaveLength(1)
    expect(l.commits[0]!.pushed).toBe(false) // no upstream ⇒ not known to be on a remote
  })

  it('a repo with no HEAD yet omits counts instead of failing the whole status', async () => {
    // `git diff HEAD --numstat` cannot run before the first commit. Counts are optional on
    // the wire precisely so this is data: the changed files still have to come back.
    const fresh = join(base, 'fresh')
    mkdirSync(fresh, { recursive: true })
    git(fresh, 'init', '-b', 'main')
    writeFileSync(join(fresh, 'a.ts'), 'x\n')
    git(fresh, 'add', 'a.ts')
    const s = await createWorkspaceGit(workspaces, async () => fresh).status(AGENT)
    expect(s.isRepo).toBe(true)
    expect(s.files?.map((f) => f.path)).toEqual(['a.ts'])
    expect(s.files?.[0]).not.toHaveProperty('additions')
  })

  it('asks whether this is a checkout THROUGH the runner, not of the daemon own disk', async () => {
    // A cluster-backed agent's checkout lives on the sandbox pod's volume, so an `existsSync` on the
    // daemon path answers about a directory that legitimately has no `.git` — and a false there
    // refused every read and every write for those agents. The probe travels with the runner.
    const seen: string[][] = []
    const answering = {
      withEnv: () => answering,
      raw: async () => '',
      clone: async () => {},
      pull: async () => ({ files: [], insertions: 0, deletions: 0 }),
      status: async () => ({ current: 'main', tracking: null, ahead: 0, behind: 0, files: [], clean: true }),
      log: async () => [],
      readBounded: async (args: string[]) => {
        seen.push(args)
        // `--show-prefix` answers EMPTY at the top level, which is what the preflight requires.
        return { out: Buffer.from(''), overflow: false }
      }
    }
    const nowhere = join(base, 'no-daemon-checkout')
    mkdirSync(nowhere, { recursive: true })

    workspaces.setGitRunnerResolver(() => answering as never)
    try {
      const status = await createWorkspaceGit(workspaces, async () => nowhere).status(AGENT)
      expect(status.isRepo).toBe(true)
      expect(seen.some((args) => args.includes('--show-prefix'))).toBe(true)
    } finally {
      workspaces.setGitRunnerResolver(undefined)
    }
  })

  it('classifies a checkout git itself does not recognise as not-a-repo, not as an empty history', async () => {
    // MEASURED, because the classification is git's and not ours: a gitdir without `.git/objects`
    // answers with the same "not a git repository" fatal a plain directory does — not a repo, said
    // by the preflight before `log` runs. `isUnbornHead` still covers the failures that DO reach it
    // (read timeout, spawn failure); those have no constructible fixture here — see M3 follow-ups.
    const broken = join(base, 'broken')
    mkdirSync(broken, { recursive: true })
    git(broken, 'init', '-b', 'main')
    writeFileSync(join(broken, 'a.ts'), 'x\n')
    git(broken, 'add', 'a.ts')
    git(broken, 'commit', '-m', 'seed')
    // Rename, not rmSync: a recursive rm swallows ENOENT under force and once left an EMPTY objects/
    // behind when a stray git child unlinked inside it mid-sweep — an atomic move has no partial state.
    renameSync(join(broken, '.git', 'objects'), join(base, 'broken-objects-gone'))

    expect(await createWorkspaceGit(workspaces, async () => broken).log({ agentId: AGENT, limit: 20 })).toEqual({
      agentId: AGENT,
      isRepo: false,
      commits: [],
      truncated: false
    })
  })

  it('an empty repo is DATA (no commits), and a from-scratch workspace is isRepo:false', async () => {
    const empty = join(base, 'empty')
    mkdirSync(empty, { recursive: true })
    git(empty, 'init', '-b', 'main')
    expect(await createWorkspaceGit(workspaces, async () => empty).log({ agentId: AGENT, limit: 20 })).toEqual({
      agentId: AGENT,
      isRepo: true,
      commits: [],
      truncated: false
    })
    expect(await seam.log({ agentId: 'scratch-agent', limit: 20 })).toEqual({
      agentId: 'scratch-agent',
      isRepo: false,
      commits: [],
      truncated: false
    })
  })

  it('caps a repository-controlled subject at the wire maximum', async () => {
    const shouty = join(base, 'shouty')
    mkdirSync(shouty, { recursive: true })
    git(shouty, 'init', '-b', 'main')
    writeFileSync(join(shouty, 'a.txt'), 'a\n')
    git(shouty, 'add', '-A')
    git(shouty, 'commit', '-m', 'x'.repeat(5_000))
    const l = await createWorkspaceGit(workspaces, async () => shouty).log({ agentId: AGENT, limit: 20 })
    expect(l.commits[0]!.subject).toHaveLength(200)
  })

  it('refuses an unknown agent with the machine-readable reason', async () => {
    await expect(seam.log({ agentId: 'nope', limit: 20 })).rejects.toMatchObject({ reason: 'unknown-agent' })
  })
})

// The cluster shape, reproduced without a cluster: the root names a path in the POD's coordinates —
// nothing on this filesystem — while git runs in the real checkout through the runner seam. Every
// answer must therefore come from git, because the daemon-local `realpath` has nothing to resolve.
// Pod coordinates are POSIX by construction — the sandbox pod is always Linux.
describe.skipIf(process.platform === 'win32')('createWorkspaceGit against a workspace this daemon cannot see', () => {
  const POD_ROOT = '/agent/repo'
  let clusterSeam: ReturnType<typeof createWorkspaceGit>

  beforeAll(() => {
    workspaces.setSandboxMode(true)
    workspaces.setGitRunnerResolver(
      (_agentId, _cwd, abort) => new LocalGitRunner(gitFor(repo, abort), repo, (e) => gitFor(repo, abort).env(e))
    )
    clusterSeam = createWorkspaceGit(workspaces, async (agentId) => (agentId === AGENT ? POD_ROOT : undefined))
  })

  afterAll(() => {
    workspaces.setSandboxMode(false)
    workspaces.setGitRunnerResolver(undefined)
  })

  it('reads the checkout at all — this is what answered isRepo:false over a real repository', async () => {
    const s = await clusterSeam.status(AGENT)
    expect(s.isRepo).toBe(true)
    expect(s.files!.map((f) => f.path)).toContain('keep.txt')
  })

  it('tells "no changes" apart from "no such file" with no filesystem to ask', async () => {
    // `exists` came from a `realpath` of the workspace root, which under --k8s resolves nothing at
    // all — so every unchanged path answered "no such file". Both answers now come from git.
    await expect(clusterSeam.diff({ agentId: AGENT, path: 'unchanged.txt', staged: false })).resolves.toEqual({
      agentId: AGENT,
      path: 'unchanged.txt',
      isRepo: true,
      exists: true
    })
    await expect(clusterSeam.diff({ agentId: AGENT, path: 'no/such/file.ts', staged: false })).resolves.toEqual({
      agentId: AGENT,
      path: 'no/such/file.ts',
      isRepo: true,
      exists: false
    })
  })

  it('counts an untracked file as present, since git diff never shows one either way', async () => {
    await expect(clusterSeam.diff({ agentId: AGENT, path: 'untracked.txt', staged: false })).resolves.toEqual({
      agentId: AGENT,
      path: 'untracked.txt',
      isRepo: true,
      exists: true
    })
  })

  it('still carries a real diff, so the existence answer did not replace the read', async () => {
    const d = await clusterSeam.diff({ agentId: AGENT, path: 'keep.txt', staged: true })
    expect(d).toMatchObject({ isRepo: true, exists: true })
    expect(d.diff).toContain('+staged addition')
  })

  it('withholds the last-fetch time rather than stat-ing a path on the wrong filesystem', async () => {
    // No git subcommand reports it — only `.git/FETCH_HEAD`'s mtime does — so "unknown" is the
    // honest answer here, and a `/agent/repo` that happened to exist on the daemon would be a lie.
    expect((await clusterSeam.status(AGENT)).lastFetchAt).toBeUndefined()
  })
})
