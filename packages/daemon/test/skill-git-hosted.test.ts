// Skill Sources off GitHub on the daemon path (source-cache.md §11): anonymous Git over local fixtures, GitLab by project id.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { AgentSkillEntry, DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS } from '@agentconnect.md/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runLocalSkillGit, type SkillGitRunner } from '../src/shim/skill-git-acquire.js'
import { GitSkillRefTracker } from '../src/skills/git-skill-ref-tracker.js'
import { GitSkillSourceCache } from '../src/skills/git-skill-source-cache.js'
import { configureGitlabSkillReads, gitlabSkillRepository } from '../src/skills/gitlab-skill-source.js'
import { gitResolutionDigest } from '../src/skills/install-skills.js'
import { nameHostedGitSkillRef } from '../src/skills/skill-git-hosted.js'
import { acquireGitSkillSource, verifyGitSkillSourceAccess } from '../src/skills/skill-git-source.js'
import { configureWorkspaceGitOrigins } from '../src/workspace/git-origin-policy.js'

const ORIGIN_URL = 'https://git.example.test/team/skills.git'
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null'
}
const ok = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, env })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

let root: string
let origin: string
const tips: Record<string, string> = {}

// A bare origin on `trunk` (two commits) with a `release` branch and a `v1` tag at the first one.
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-skill-hosted-')))
  origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  ok(root, ['init', '-q', '--bare', '--initial-branch=trunk', origin])
  ok(origin, ['config', 'uploadpack.allowFilter', 'true'])
  mkdirSync(join(seed, 'skills', 'alpha'), { recursive: true })
  ok(seed, ['init', '-q', '--initial-branch=trunk'])
  writeFileSync(join(seed, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nalpha one\n')
  writeFileSync(join(seed, 'README.md'), 'outside the subdirectory\n')
  ok(seed, ['add', '-A'])
  ok(seed, ['commit', '-qm', 'one'])
  tips.one = ok(seed, ['rev-parse', 'HEAD'])
  ok(seed, ['branch', 'release'])
  ok(seed, ['tag', '-a', 'v1', '-m', 'v1'])
  writeFileSync(join(seed, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nalpha two\n')
  ok(seed, ['commit', '-qam', 'two'])
  tips.trunk = ok(seed, ['rev-parse', 'HEAD'])
  ok(seed, ['remote', 'add', 'origin', origin])
  ok(seed, ['push', '-q', '--follow-tags', 'origin', 'trunk', 'release'])
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

afterEach(() => {
  configureWorkspaceGitOrigins(DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS)
  configureGitlabSkillReads(undefined)
})

/** The real local Git behind the test's https name, recording each argv. */
function fixtureGit(calls: string[][] = []): SkillGitRunner {
  return async (invocation) => {
    calls.push(invocation.args)
    return await runLocalSkillGit({
      ...invocation,
      args: invocation.args.map((arg) => (arg === ORIGIN_URL ? `file://${origin}` : arg))
    })
  }
}

const anonymous = (overrides: Partial<AgentSkillEntry> = {}): AgentSkillEntry =>
  AgentSkillEntry.parse({ name: 'elsewhere', source: ORIGIN_URL, skills: [], ...overrides })

describe('anonymous Sources on another host (daemon path)', () => {
  it.skipIf(process.platform === 'win32')(
    'names the default branch, a short name and a full ref with one scoped listing each',
    async () => {
      const home = await mkdtemp(join(root, 'naming-'))
      const calls: string[][] = []
      const name = (n?: string) =>
        nameHostedGitSkillRef({
          url: ORIGIN_URL,
          ...(n !== undefined ? { name: n } : {}),
          privateHome: home,
          git: fixtureGit(calls),
          allowFileProtocol: true
        })
      expect(await name()).toEqual({ kind: 'named', ref: 'refs/heads/trunk', commit: tips.trunk })
      expect(await name('HEAD')).toEqual({ kind: 'named', ref: 'refs/heads/trunk', commit: tips.trunk })
      expect(await name('release')).toEqual({ kind: 'named', ref: 'refs/heads/release', commit: tips.one })
      // An annotated tag names its peeled commit.
      expect(await name('v1')).toEqual({ kind: 'named', ref: 'refs/tags/v1', commit: tips.one })
      expect(await name('refs/tags/v1')).toEqual({ kind: 'named', ref: 'refs/tags/v1', commit: tips.one })
      expect(await name('absent')).toEqual({ kind: 'unnamed', reason: 'absent' })
      expect(await name('a..b')).toEqual({ kind: 'unnamed', reason: 'invalid' })
      expect(calls.every((args) => args[0] === 'ls-remote' && args.includes('--'))).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'acquires a tracked ref and a pinned commit, laying the subdirectory out like an archive',
    async () => {
      const destination = await mkdtemp(join(root, 'acquire-'))
      const tracked = await acquireGitSkillSource(anonymous({ ref: 'release', subDir: 'skills' }), {
        destination,
        agentId: 'agent-1',
        useGitCredential: true,
        git: fixtureGit(),
        allowFileProtocol: true
      })
      expect(tracked.resolvedCommit).toBe(tips.one)
      expect(tracked.sourceDir).toBe(join(destination, 'repository', 'skills'))
      expect(await readFile(join(tracked.sourceDir, 'alpha', 'SKILL.md'), 'utf8')).toContain('alpha one')
      // Only the subdirectory is checked out, and the staging Git directory is gone.
      expect(existsSync(join(destination, 'repository', 'README.md'))).toBe(false)
      expect(existsSync(join(destination, 'git'))).toBe(true)

      const pinnedDestination = await mkdtemp(join(root, 'acquire-pinned-'))
      const pinned = await acquireGitSkillSource(anonymous({ ref: tips.trunk }), {
        destination: pinnedDestination,
        agentId: 'agent-1',
        useGitCredential: false,
        git: fixtureGit(),
        allowFileProtocol: true
      })
      expect(pinned.resolvedCommit).toBe(tips.trunk)
      expect(await readFile(join(pinned.sourceDir, 'README.md'), 'utf8')).toContain('outside')
      expect(await readFile(join(pinned.sourceDir, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('alpha two')
    }
  )

  it('refuses an origin the operator policy excludes before any Git or directory work', async () => {
    configureWorkspaceGitOrigins(['https://github.com'])
    const destination = join(root, 'refused')
    const calls: string[][] = []
    await expect(
      acquireGitSkillSource(anonymous(), {
        destination,
        agentId: 'agent-1',
        useGitCredential: false,
        git: fixtureGit(calls)
      })
    ).rejects.toThrow(/is not allowed by this daemon/)
    expect(calls).toEqual([])
    expect(existsSync(destination)).toBe(false)
  })

  it('never contacts the host to re-prove an anonymous cache hit', async () => {
    await expect(
      verifyGitSkillSourceAccess(anonymous(), {
        agentId: 'agent-1',
        useGitCredential: false,
        privateHome: join(root, 'unused'),
        fetch: async () => {
          throw new Error('must not fetch')
        }
      })
    ).resolves.toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'is tracked by the shared anonymous check, which names the ref with the commit',
    async () => {
      let rest = 0
      const tracker = new GitSkillRefTracker({
        stateRoot: await mkdtemp(join(root, 'tracker-')),
        resolve: async () => {
          rest += 1
          throw new Error('github REST must not be asked')
        },
        nameHostedRef: (input) => nameHostedGitSkillRef({ ...input, git: fixtureGit(), allowFileProtocol: true })
      })
      expect(await tracker.resolveTracked(anonymous({ ref: 'release' }))).toEqual({
        commit: tips.one,
        ref: 'refs/heads/release'
      })
      expect(await tracker.resolve(anonymous())).toBe(tips.trunk)
      // A pinned commit is never asked about.
      expect(await tracker.resolve(anonymous({ ref: tips.one }))).toBeNull()
      expect(rest).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'caches an anonymous Source per subdirectory, since its tree holds only that subdirectory',
    async () => {
      const acquired: Array<string | undefined> = []
      const cache = new GitSkillSourceCache(await mkdtemp(join(root, 'cache-')), {
        acquire: async (entry, opts) => {
          acquired.push(entry.subDir)
          return await acquireGitSkillSource(entry, { ...opts, git: fixtureGit(), allowFileProtocol: true })
        },
        verifyAccess: async () => undefined
      })
      const opts = { agentId: 'agent-1', useGitCredential: false }
      const skills = await cache.resolve(anonymous({ subDir: 'skills' }), tips.trunk, opts)
      const again = await cache.resolve(anonymous({ subDir: 'skills' }), tips.trunk, opts)
      const whole = await cache.resolve(anonymous(), tips.trunk, opts)
      expect(again).toMatchObject({ cached: true, sourceDir: skills.sourceDir })
      expect(whole.cached).toBe(false)
      expect(await readFile(join(whole.sourceDir, 'README.md'), 'utf8')).toContain('outside')
      expect(acquired).toEqual(['skills', undefined])
    }
  )
})

const GITLAB_SOURCE = 'https://gitlab.example.test/group/sub/skills'
const gitlabEntry = (overrides: Partial<AgentSkillEntry> = {}): AgentSkillEntry =>
  AgentSkillEntry.parse({
    name: 'gitlab',
    source: GITLAB_SOURCE,
    credential: { provider: 'gitlab', projectId: '77' },
    skills: [],
    ...overrides
  })

function tarGzip(files: Record<string, string>, rootDir: string): Buffer {
  const chunks: Buffer[] = []
  const header = (path: string, type: '0' | '5', size: number): Buffer => {
    const h = Buffer.alloc(512)
    h.write(path, 0)
    h.write(`${(type === '5' ? 0o755 : 0o644).toString(8).padStart(7, '0')}\0`, 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
    h.write('00000000000\0', 136)
    h.fill(0x20, 148, 156)
    h.write(type, 156)
    h.write('ustar\0', 257)
    h.write('00', 263)
    const sum = h.reduce((total, byte) => total + byte, 0)
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    return h
  }
  chunks.push(header(`${rootDir}/`, '5', 0))
  for (const [path, body] of Object.entries(files)) {
    const data = Buffer.from(body)
    chunks.push(header(`${rootDir}/${path}`, '0', data.length), data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

describe('credentialed GitLab Sources (daemon path)', () => {
  const COMMIT = 'c'.repeat(40)

  it('measures the project from the spec instance, or the Source origin when the spec names none', () => {
    const entry = gitlabEntry()
    expect(gitlabSkillRepository(entry, GITLAB_SOURCE, undefined)).toMatchObject({
      provider: 'gitlab',
      externalId: '77',
      path: 'group/sub/skills',
      baseUrl: 'https://gitlab.example.test',
      apiBaseUrl: 'https://gitlab.example.test/api/v4'
    })
    expect(
      gitlabSkillRepository(
        entry,
        'https://gitlab.example.test/prefix/group/skills.git',
        'https://gitlab.example.test/prefix/'
      )
    ).toMatchObject({ path: 'group/skills', apiBaseUrl: 'https://gitlab.example.test/prefix/api/v4' })
    // Off the spec's instance, or with no namespace, there is no project to read.
    expect(gitlabSkillRepository(entry, GITLAB_SOURCE, 'https://code.example.test')).toBeUndefined()
    expect(gitlabSkillRepository(entry, 'https://gitlab.example.test/skills', undefined)).toBeUndefined()
    expect(gitlabSkillRepository(anonymous(), ORIGIN_URL, undefined)).toBeUndefined()
  })

  it('resolves through the agent, then downloads the archive by project id with the read token', async () => {
    const resolved: string[] = []
    configureGitlabSkillReads({
      host: () => undefined,
      resolve: async (entry, agentId) => {
        resolved.push(`${agentId}:${entry.ref ?? 'HEAD'}`)
        return { ok: true, commit: COMMIT, ref: 'refs/heads/main', checkedAt: 0 }
      },
      token: async (agentId, repository) => `token-${agentId}-${repository.externalId}`
    })
    const archive = tarGzip({ 'skills/alpha/SKILL.md': '# alpha\n' }, `skills-${COMMIT.slice(0, 12)}`)
    const calls: Array<{ url: string; token: string | null; redirect: RequestInit['redirect'] }> = []
    const destination = await mkdtemp(join(root, 'gitlab-'))
    const result = await acquireGitSkillSource(gitlabEntry({ ref: 'main', subDir: 'skills' }), {
      destination,
      agentId: 'agent-1',
      useGitCredential: false,
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          token: new Headers(init?.headers).get('private-token'),
          redirect: init?.redirect
        })
        return new Response(new Uint8Array(archive), { status: 200 })
      }
    })
    expect(resolved).toEqual(['agent-1:main'])
    expect(calls).toEqual([
      {
        url: `https://gitlab.example.test/api/v4/projects/77/repository/archive.tar.gz?sha=${COMMIT}`,
        token: 'token-agent-1-77',
        redirect: 'error'
      }
    ])
    expect(result.resolvedCommit).toBe(COMMIT)
    expect(await readFile(join(result.sourceDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha\n')
  })

  it('fails closed when resolution refuses, before any download or directory', async () => {
    configureGitlabSkillReads({
      host: () => undefined,
      resolve: async () => ({ ok: false, reason: 'replaced', detail: 'renamed', checkedAt: 0 }),
      token: async () => 'token'
    })
    const destination = join(root, 'gitlab-refused')
    const fetch = async (): Promise<Response> => {
      throw new Error('must not fetch')
    }
    await expect(
      acquireGitSkillSource(gitlabEntry(), { destination, agentId: 'agent-1', useGitCredential: false, fetch })
    ).rejects.toThrow(/resolution failed \(replaced\)/)
    expect(existsSync(destination)).toBe(false)
    // A cache hit re-proves the project the same way.
    await expect(
      verifyGitSkillSourceAccess(gitlabEntry(), {
        agentId: 'agent-1',
        useGitCredential: false,
        privateHome: join(root, 'unused')
      })
    ).rejects.toThrow(/resolution failed/)
  })

  it('fails closed on a daemon with no GitLab reads configured', async () => {
    await expect(
      acquireGitSkillSource(gitlabEntry(), {
        destination: join(root, 'gitlab-unconfigured'),
        agentId: 'agent-1',
        useGitCredential: false
      })
    ).rejects.toThrow(/not configured/)
  })

  it('keeps every GitHub and anonymous resolution digest, and separates GitLab projects', () => {
    const github = AgentSkillEntry.parse({ name: 'gh', source: 'acme/skills', githubRepoId: '42', skills: [] })
    const legacy = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    expect(gitResolutionDigest(github)).toBe(
      legacy({ githubRepoId: '42', cloneUrl: 'https://github.com/acme/skills.git', ref: 'HEAD' })
    )
    expect(gitResolutionDigest(anonymous())).toBe(legacy({ cloneUrl: ORIGIN_URL, ref: 'HEAD' }))
    expect(gitResolutionDigest(gitlabEntry())).not.toBe(
      gitResolutionDigest(gitlabEntry({ credential: { provider: 'gitlab', projectId: '78' } }))
    )
  })
})
