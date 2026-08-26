import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS } from '@agentconnect.md/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GIT_SKILL_ARCHIVE_LIMITS,
  acquireGitSkillSource,
  buildSkillGitAcquisitionEnv,
  parseGitSkillSource,
  resolveAuthorizedGitSkillCloneUrl,
  resolveBoundedGitSkillSource,
  type GitSkillCredentialRequest
} from '../src/skills/skill-git-source.js'
import { daemonGitCredentialTarget, initGitInjection } from '../src/workspace/git-injection.js'
import { configureWorkspaceGitOrigins } from '../src/workspace/git-origin-policy.js'

const entry = (source: string, githubRepoId = '42') => ({
  name: 'source',
  source,
  githubRepoId,
  skills: [] as string[]
})
const SHA = '0123456789abcdef0123456789abcdef01234567'

interface TarFixtureEntry {
  path: string
  type?: '0' | '2' | '5' | 'V' | 'x'
  body?: string | Buffer
  linkpath?: string
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value)
  if (encoded.length > length) throw new Error('tar fixture field is too long')
  encoded.copy(header, offset)
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeTarString(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

function tarGzip(entries: TarFixtureEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const fixture of entries) {
    const type = fixture.type ?? '0'
    const body = type === '0' || type === 'x' ? Buffer.from(fixture.body ?? '') : Buffer.alloc(0)
    const header = Buffer.alloc(512)
    writeTarString(header, 0, 100, fixture.path)
    writeTarOctal(header, 100, 8, type === '5' ? 0o755 : 0o644)
    writeTarOctal(header, 108, 8, 0)
    writeTarOctal(header, 116, 8, 0)
    writeTarOctal(header, 124, 12, body.length)
    writeTarOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = type.charCodeAt(0)
    if (fixture.linkpath) writeTarString(header, 157, 100, fixture.linkpath)
    writeTarString(header, 257, 6, 'ustar\0')
    writeTarString(header, 263, 2, '00')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
    chunks.push(header, body)
    const padding = (512 - (body.length % 512)) % 512
    if (padding) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

interface FetchCall {
  url: string
  authorization: string | null
  redirect: RequestInit['redirect']
}

function offlineGitHubFetch(opts: {
  archive: Buffer
  location?: string
  requireAuth?: boolean
  codeloadStatus?: number
  commitBody?: string
  identities?: Array<{ status?: number; id?: string; fullName?: string; private?: boolean }>
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  let identityIndex = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const authorization = headers.get('authorization')
    calls.push({ url, authorization, redirect: init?.redirect })

    if (url.startsWith('https://api.github.com/repositories/')) {
      const identities = opts.identities ?? [{}]
      const identity = identities[Math.min(identityIndex, identities.length - 1)] ?? {}
      identityIndex += 1
      const status = identity.status ?? 200
      if (status !== 200) return new Response('', { status })
      const body = `{"id":${identity.id ?? '42'},"full_name":${JSON.stringify(identity.fullName ?? 'acme/skills')},"private":${identity.private ?? false}}`
      return new Response(body, {
        status: 200,
        headers: { 'content-length': String(body.length) }
      })
    }
    if (url.includes('/commits/')) {
      if (opts.requireAuth && !authorization) return new Response('', { status: 404 })
      const commitBody = opts.commitBody ?? SHA
      return new Response(commitBody, {
        status: 200,
        headers: { 'content-length': String(commitBody.length) }
      })
    }
    if (url.includes('/tarball/')) {
      if (opts.requireAuth && !authorization) return new Response('', { status: 404 })
      return new Response(null, {
        status: 302,
        headers: {
          location: opts.location ?? `https://codeload.github.com/acme/skills/legacy.tar.gz/${SHA}`
        }
      })
    }
    if (url.startsWith('https://codeload.github.com/')) {
      return new Response(new Uint8Array(opts.archive), {
        status: opts.codeloadStatus ?? 200,
        headers: { 'content-length': String(opts.archive.length) }
      })
    }
    throw new Error('unexpected offline URL')
  }
  return { fetch, calls }
}

function gitConfig(env: Record<string, string>): Map<string, string> {
  const config = new Map<string, string>()
  const count = Number(env.GIT_CONFIG_COUNT)
  expect(Number.isSafeInteger(count)).toBe(true)
  for (let index = 0; index < count; index++) {
    config.set(env[`GIT_CONFIG_KEY_${index}`]!, env[`GIT_CONFIG_VALUE_${index}`]!)
  }
  return config
}

describe('Git skill source policy boundary', () => {
  beforeEach(() => configureWorkspaceGitOrigins(DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS))
  afterEach(() => configureWorkspaceGitOrigins(DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS))

  it('parses shorthand and GitHub tree forms through the shared policy', () => {
    expect(parseGitSkillSource({ ...entry('acme/skills'), ref: 'v1', subDir: 'pack' })).toEqual({
      cloneUrl: 'https://github.com/acme/skills.git',
      ref: 'v1',
      subDir: 'pack'
    })
    expect(parseGitSkillSource(entry('https://github.com/acme/skills/tree/main/packs/core'))).toEqual({
      cloneUrl: 'https://github.com/acme/skills.git',
      ref: 'main',
      subDir: 'packs/core'
    })
  })

  it('accepts CP-supported GitHub transports and canonicalizes standard SSH acquisition to HTTPS', () => {
    expect(parseGitSkillSource(entry('https://github.com/acme/skills.git')).cloneUrl).toBe(
      'https://github.com/acme/skills.git'
    )
    expect(parseGitSkillSource(entry('ssh://git@github.com/acme/skills.git')).cloneUrl).toBe(
      'ssh://git@github.com/acme/skills.git'
    )
    expect(parseGitSkillSource(entry('git@github.com:acme/skills.git')).cloneUrl).toBe('git@github.com:acme/skills.git')
    expect(resolveAuthorizedGitSkillCloneUrl('ssh://git@github.com/acme/skills.git')).toBe(
      'https://github.com/acme/skills.git'
    )
    expect(resolveAuthorizedGitSkillCloneUrl('git@github.com:acme/skills.git')).toBe(
      'https://github.com/acme/skills.git'
    )
    expect(() => resolveBoundedGitSkillSource(entry('root@github.com:acme/skills.git'))).toThrow(
      /only canonical GitHub HTTPS/i
    )
  })

  it('rejects disallowed hosts, private addresses, and custom ports', () => {
    for (const source of [
      'https://code.example.test/acme/skills.git',
      'https://127.0.0.1/acme/skills.git',
      'https://github.com:8443/acme/skills.git',
      'ssh://git@github.com:2222/acme/skills.git'
    ]) {
      expect(() => parseGitSkillSource(entry(source)), source).toThrow(/origin is not allowed/i)
    }
  })

  it('honors an operator-authorized exact non-default origin', () => {
    configureWorkspaceGitOrigins([...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS, 'https://git.example.test'])
    expect(parseGitSkillSource(entry('https://git.example.test/acme/skills.git')).cloneUrl).toBe(
      'https://git.example.test/acme/skills.git'
    )
    // §13.2: gitlab.com is a DEFAULT origin now — skill sources may name it
    // without operator opt-in (credentialed acquisition stays GitHub-only).
    configureWorkspaceGitOrigins([...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS])
    expect(parseGitSkillSource(entry('https://gitlab.com/acme/skills.git')).cloneUrl).toBe(
      'https://gitlab.com/acme/skills.git'
    )
  })

  it('rejects a disallowed acquisition before creating its destination or invoking Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-policy-'))
    const destination = join(root, 'acquired')
    try {
      await expect(
        acquireGitSkillSource(entry('https://code.example.test/acme/skills.git'), {
          destination,
          agentId: 'agent-1',
          useGitCredential: true
        })
      ).rejects.toThrow(/origin is not allowed/i)
      expect(existsSync(destination)).toBe(false)
      // A default-allowed gitlab origin still refuses the CREDENTIALED path,
      // which remains canonical-GitHub-only, before any directory or Git work.
      await expect(
        acquireGitSkillSource(entry('https://gitlab.com/acme/skills.git'), {
          destination,
          agentId: 'agent-1',
          useGitCredential: true
        })
      ).rejects.toThrow(/canonical GitHub/i)
      expect(existsSync(destination)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exposes the narrower bounded-acquisition admission contract', () => {
    expect(resolveBoundedGitSkillSource(entry('git@github.com:acme/skills.git'))).toEqual({
      cloneUrl: 'https://github.com/acme/skills.git'
    })

    configureWorkspaceGitOrigins([...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS, 'https://gitlab.com'])
    expect(() => resolveBoundedGitSkillSource(entry('https://gitlab.com/acme/skills.git'))).toThrow(
      /only canonical GitHub HTTPS/i
    )

    configureWorkspaceGitOrigins(['ssh://github.com'])
    expect(() => resolveBoundedGitSkillSource(entry('git@github.com:acme/skills.git'))).toThrow(
      /only canonical GitHub HTTPS/i
    )
  })

  it('fails an operator-authorized but unsupported origin before destination or network effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-unsupported-'))
    const destination = join(root, 'acquired')
    let fetchCalled = false
    configureWorkspaceGitOrigins([...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS, 'https://gitlab.com'])
    try {
      await expect(
        acquireGitSkillSource(entry('https://gitlab.com/acme/skills.git'), {
          destination,
          agentId: 'agent-1',
          useGitCredential: false,
          fetch: async () => {
            fetchCalled = true
            throw new Error('must not fetch')
          }
        })
      ).rejects.toThrow(/only canonical GitHub HTTPS/i)
      expect(fetchCalled).toBe(false)
      expect(existsSync(destination)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Asserts extracted-tree mode bits, which Windows does not carry.
  it.skipIf(process.platform === 'win32')(
    'resolves an exact commit and extracts a bounded GitHub archive without Git object fetches',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-archive-'))
      const archive = tarGzip([
        { path: `skills-${SHA}/`, type: '5' },
        { path: `skills-${SHA}/packs/core/SKILL.md`, body: '# bounded\n' }
      ])
      const offline = offlineGitHubFetch({ archive })
      try {
        const result = await acquireGitSkillSource(
          { ...entry('git@github.com:acme/skills.git'), ref: 'main', subDir: 'packs/core' },
          {
            destination: join(root, 'acquired'),
            agentId: 'agent-1',
            useGitCredential: false,
            fetch: offline.fetch
          }
        )

        expect(result.resolvedCommit).toBe(SHA)
        expect(result.source.cloneUrl).toBe('https://github.com/acme/skills.git')
        expect(await readFile(join(result.sourceDir, 'SKILL.md'), 'utf8')).toBe('# bounded\n')
        expect((await stat(result.sourceDir)).mode & 0o777).toBe(0o700)
        expect((await stat(join(result.sourceDir, 'SKILL.md'))).mode & 0o777).toBe(0o600)
        expect(offline.calls.map((call) => call.url)).toEqual([
          'https://api.github.com/repositories/42',
          'https://api.github.com/repos/acme/skills/commits/main',
          'https://api.github.com/repositories/42',
          `https://api.github.com/repos/acme/skills/tarball/${SHA}`,
          `https://codeload.github.com/acme/skills/legacy.tar.gz/${SHA}`
        ])
        expect(offline.calls.map((call) => call.redirect)).toEqual(['error', 'error', 'error', 'manual', 'error'])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('compares repository ids exactly beyond Number.MAX_SAFE_INTEGER', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-large-id-'))
    const githubRepoId = '9007199254740993'
    const offline = offlineGitHubFetch({
      archive: tarGzip([{ path: `skills-${SHA}/SKILL.md`, body: 'exact id' }]),
      identities: [{ id: githubRepoId }]
    })
    try {
      await expect(
        acquireGitSkillSource(entry('acme/skills', githubRepoId), {
          destination: join(root, 'acquired'),
          agentId: 'agent-1',
          useGitCredential: false,
          fetch: offline.fetch
        })
      ).resolves.toMatchObject({ resolvedCommit: SHA })
      expect(offline.calls.filter((call) => call.url.includes('/repositories/')).map((call) => call.url)).toEqual([
        `https://api.github.com/repositories/${githubRepoId}`,
        `https://api.github.com/repositories/${githubRepoId}`
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.env.AGENTCONNECT_LIVE_GITHUB_SMOKE === '1')(
    'acquires a real public GitHub archive through the bounded path',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-live-'))
      try {
        const result = await acquireGitSkillSource(entry('octocat/Hello-World', '1296269'), {
          destination: join(root, 'acquired'),
          agentId: 'agent-1',
          useGitCredential: false,
          timeoutMs: 30_000
        })
        expect(result.resolvedCommit).toMatch(/^[a-f0-9]{40}$/)
        expect(await readFile(join(result.sourceDir, 'README'), 'utf8')).toMatch(/Hello World/i)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    35_000
  )

  it('caps both compressed and uncompressed archive bytes before extraction', async () => {
    const archive = tarGzip([{ path: `skills-${SHA}/SKILL.md`, body: 'x'.repeat(4_096) }])
    for (const testCase of [
      {
        name: 'compressed',
        limits: { maxCompressedBytes: archive.length - 1 },
        error: /compressed byte limit/i
      },
      { name: 'uncompressed', limits: { maxTarBytes: 1_024 }, error: /uncompressed byte limit/i }
    ]) {
      const root = await mkdtemp(join(tmpdir(), `ac-skill-git-${testCase.name}-`))
      const offline = offlineGitHubFetch({ archive })
      try {
        await expect(
          acquireGitSkillSource(entry('acme/skills'), {
            destination: join(root, 'acquired'),
            agentId: 'agent-1',
            useGitCredential: false,
            fetch: offline.fetch,
            archiveLimits: testCase.limits
          })
        ).rejects.toThrow(testCase.error)
        expect(existsSync(join(root, 'acquired/repository/SKILL.md'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('enforces per-file, entry-count, and depth limits during validation', async () => {
    const cases = [
      {
        archive: tarGzip([{ path: `skills-${SHA}/SKILL.md`, body: 'oversized' }]),
        limits: { maxFileBytes: 4 },
        error: /oversized file/i
      },
      {
        archive: tarGzip([
          { path: `skills-${SHA}/one`, body: '1' },
          { path: `skills-${SHA}/two`, body: '2' }
        ]),
        limits: { maxEntries: 1 },
        error: /too many entries/i
      },
      {
        archive: tarGzip([
          { path: 'PaxHeader', type: 'x', body: '13 comment=x\n' },
          { path: `skills-${SHA}/SKILL.md`, body: 'safe' }
        ]),
        limits: { maxEntries: 1 },
        error: /too many entries/i
      },
      {
        archive: tarGzip([
          { path: `skills-${SHA}/one`, body: '12' },
          { path: `skills-${SHA}/two`, body: '34' }
        ]),
        limits: { maxTotalFileBytes: 3 },
        error: /total file byte limit/i
      },
      {
        archive: tarGzip([{ path: `skills-${SHA}/one/two/SKILL.md`, body: 'deep' }]),
        limits: { maxDepth: 2 },
        error: /depth limit/i
      }
    ]

    for (const [index, testCase] of cases.entries()) {
      const root = await mkdtemp(join(tmpdir(), `ac-skill-git-entry-${index}-`))
      const offline = offlineGitHubFetch({ archive: testCase.archive })
      try {
        await expect(
          acquireGitSkillSource(entry('acme/skills'), {
            destination: join(root, 'acquired'),
            agentId: 'agent-1',
            useGitCredential: false,
            fetch: offline.fetch,
            archiveLimits: testCase.limits
          })
        ).rejects.toThrow(testCase.error)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('skips a repo-level symlink outside every skill directory without materializing it (#371)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-repo-link-'))
    // The mattpocock/skills shape: an AGENTS.md -> CLAUDE.md symlink at the
    // repository root, unrelated to the nested skill being installed.
    const archive = tarGzip([
      { path: `skills-${SHA}/CLAUDE.md`, body: '# repo instructions\n' },
      { path: `skills-${SHA}/AGENTS.md`, type: '2', linkpath: 'CLAUDE.md' },
      { path: `skills-${SHA}/skills/productivity/grill-me/SKILL.md`, body: '---\nname: grill-me\n---\n# grill\n' }
    ])
    const offline = offlineGitHubFetch({ archive })
    try {
      const result = await acquireGitSkillSource(entry('acme/skills'), {
        destination: join(root, 'acquired'),
        agentId: 'agent-1',
        useGitCredential: false,
        fetch: offline.fetch
      })
      expect(await readFile(join(result.sourceDir, 'skills/productivity/grill-me/SKILL.md'), 'utf8')).toContain(
        '# grill'
      )
      expect(await readFile(join(result.sourceDir, 'CLAUDE.md'), 'utf8')).toContain('repo instructions')
      expect(existsSync(join(result.sourceDir, 'AGENTS.md'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still rejects a link inside a skill directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-skill-link-'))
    const archive = tarGzip([
      { path: `skills-${SHA}/skills/grill-me/SKILL.md`, body: '---\nname: grill-me\n---\n# grill\n' },
      { path: `skills-${SHA}/skills/grill-me/scripts/escape`, type: '2', linkpath: '/tmp/outside' }
    ])
    const offline = offlineGitHubFetch({ archive })
    try {
      await expect(
        acquireGitSkillSource(entry('acme/skills'), {
          destination: join(root, 'acquired'),
          agentId: 'agent-1',
          useGitCredential: false,
          fetch: offline.fetch
        })
      ).rejects.toThrow(/link or special entry inside a skill directory/i)
      expect(existsSync(join(root, 'acquired/repository/skills/grill-me/SKILL.md'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects symlink and parser-ignored special archive entries before writing them', async () => {
    for (const [name, special] of [
      ['symlink', { path: `skills-${SHA}/escape`, type: '2' as const, linkpath: '/tmp/outside' }],
      ['volume', { path: `skills-${SHA}/volume`, type: 'V' as const }]
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `ac-skill-git-${name}-`))
      const archive = tarGzip([{ path: `skills-${SHA}/SKILL.md`, body: '# safe\n' }, special])
      const offline = offlineGitHubFetch({ archive })
      try {
        await expect(
          acquireGitSkillSource(entry('acme/skills'), {
            destination: join(root, 'acquired'),
            agentId: 'agent-1',
            useGitCredential: false,
            fetch: offline.fetch
          })
        ).rejects.toThrow(/link or special/i)
        expect(existsSync(join(root, 'acquired/repository/SKILL.md'))).toBe(false)
        expect(existsSync(join(root, 'acquired/repository/escape'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('bounds exact commit resolution before archive acquisition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-commit-cap-'))
    const offline = offlineGitHubFetch({
      archive: tarGzip([{ path: `skills-${SHA}/SKILL.md`, body: 'safe' }]),
      commitBody: 'x'.repeat(129)
    })
    try {
      await expect(
        acquireGitSkillSource(entry('acme/skills'), {
          destination: join(root, 'acquired'),
          agentId: 'agent-1',
          useGitCredential: false,
          fetch: offline.fetch
        })
      ).rejects.toThrow(/commit resolution exceeded the byte limit/i)
      expect(offline.calls).toHaveLength(2)
      expect(offline.calls.map((call) => call.redirect)).toEqual(['error', 'error'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows test seams to tighten but never widen daemon archive ceilings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-limit-ceiling-'))
    const destination = join(root, 'acquired')
    let fetchCalled = false
    try {
      await expect(
        acquireGitSkillSource(entry('acme/skills'), {
          destination,
          agentId: 'agent-1',
          useGitCredential: false,
          fetch: async () => {
            fetchCalled = true
            throw new Error('must not fetch')
          },
          archiveLimits: {
            maxCompressedBytes: DEFAULT_GIT_SKILL_ARCHIVE_LIMITS.maxCompressedBytes + 1
          }
        })
      ).rejects.toThrow(/may not exceed the daemon ceiling/i)
      expect(fetchCalled).toBe(false)
      expect(existsSync(destination)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an archive redirect outside the exact derived codeload boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-redirect-'))
    const offline = offlineGitHubFetch({
      archive: tarGzip([{ path: `skills-${SHA}/SKILL.md`, body: 'safe' }]),
      location: `https://evil.example/acme/skills/legacy.tar.gz/${SHA}`
    })
    try {
      await expect(
        acquireGitSkillSource(entry('acme/skills'), {
          destination: join(root, 'acquired'),
          agentId: 'agent-1',
          useGitCredential: false,
          fetch: offline.fetch
        })
      ).rejects.toThrow(/disallowed location/i)
      expect(offline.calls).toHaveLength(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses a scoped identity lookup without enabling a private skill source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-auth-'))
    const archive = tarGzip([{ path: `skills-${SHA}/SKILL.md`, body: 'private' }])
    const offline = offlineGitHubFetch({
      archive,
      identities: [{ status: 404 }, { private: true }]
    })
    const credentialRequests: GitSkillCredentialRequest[] = []
    try {
      await expect(
        acquireGitSkillSource(entry('acme/skills'), {
          destination: join(root, 'acquired'),
          agentId: 'agent-1',
          useGitCredential: true,
          fetch: offline.fetch,
          credentialProvider: async (request) => {
            credentialRequests.push(request)
            return { username: 'x-access-token', password: 'private-token' }
          }
        })
      ).rejects.toThrow(/private skill sources are not supported/i)

      expect(credentialRequests).toHaveLength(1)
      expect(credentialRequests[0]).toMatchObject({
        agentId: 'agent-1',
        cloneUrl: 'https://github.com/acme/skills.git',
        repositoryPath: 'acme/skills'
      })
      expect(offline.calls.map((call) => call.authorization)).toEqual([null, 'Bearer private-token'])
      expect(offline.calls.map((call) => call.url)).toEqual([
        'https://api.github.com/repositories/42',
        'https://api.github.com/repositories/42'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never lets an anonymous old-name replacement bypass the numeric identity gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-old-name-'))
    const offline = offlineGitHubFetch({
      archive: tarGzip([{ path: `skills-${SHA}/SKILL.md`, body: 'attacker' }]),
      identities: [{ status: 404 }, { status: 404 }]
    })
    const credentialRequests: GitSkillCredentialRequest[] = []
    try {
      await expect(
        acquireGitSkillSource(entry('acme/skills'), {
          destination: join(root, 'acquired'),
          agentId: 'agent-1',
          useGitCredential: true,
          fetch: offline.fetch,
          credentialProvider: async (request) => {
            credentialRequests.push(request)
            return { username: 'x-access-token', password: 'private-token' }
          }
        })
      ).rejects.toThrow(/identity lookup failed with status 404/i)

      expect(credentialRequests).toHaveLength(1)
      expect(offline.calls.map((call) => call.url)).toEqual([
        'https://api.github.com/repositories/42',
        'https://api.github.com/repositories/42'
      ])
      expect(offline.calls.map((call) => call.authorization)).toEqual([null, 'Bearer private-token'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['numeric id', [{ id: '43' }]],
    ['canonical name', [{ fullName: 'attacker/skills' }]],
    ['public visibility', [{ private: true }]]
  ])('rejects a mismatched %s before any name-based GitHub request', async (_label, identities) => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-identity-mismatch-'))
    const offline = offlineGitHubFetch({
      archive: tarGzip([{ path: `skills-${SHA}/SKILL.md`, body: 'unsafe' }]),
      identities
    })
    try {
      await expect(
        acquireGitSkillSource(entry('acme/skills'), {
          destination: join(root, 'acquired'),
          agentId: 'agent-1',
          useGitCredential: false,
          fetch: offline.fetch
        })
      ).rejects.toThrow(/identity does not match|private skill sources are not supported/i)
      expect(offline.calls.map((call) => call.url)).toEqual(['https://api.github.com/repositories/42'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rechecks numeric identity after commit resolution before requesting the name-based archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-git-identity-race-'))
    const offline = offlineGitHubFetch({
      archive: tarGzip([{ path: `skills-${SHA}/SKILL.md`, body: 'unsafe' }]),
      identities: [{}, { status: 404 }]
    })
    try {
      await expect(
        acquireGitSkillSource(entry('acme/skills'), {
          destination: join(root, 'acquired'),
          agentId: 'agent-1',
          useGitCredential: false,
          fetch: offline.fetch
        })
      ).rejects.toThrow(/identity lookup failed with status 404/i)
      expect(offline.calls.map((call) => call.url)).toEqual([
        'https://api.github.com/repositories/42',
        'https://api.github.com/repos/acme/skills/commits/HEAD',
        'https://api.github.com/repositories/42'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps redirect and transport restrictions on the exact authorized target', () => {
    const cloneUrl = 'https://github.com/acme/skills.git'
    const env = buildSkillGitAcquisitionEnv({
      agentId: 'agent-1',
      cloneUrl,
      privateHome: '/private/home',
      useGitCredential: false
    })
    const config = gitConfig(env)

    expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh')
    expect(config.get('http.followRedirects')).toBe('false')
    expect(config.get(`http.${cloneUrl}.followRedirects`)).toBe('false')
    expect(config.get(`http.${cloneUrl}.proxy`)).toBe('')
    expect(config.get(`http.${cloneUrl}.curloptResolve`)).toBe('')
    expect(config.get(`url.${cloneUrl}.insteadOf`)).toBe(cloneUrl)
  })

  it('never forwards the GitHub credential capability to retained SSH origins', () => {
    configureWorkspaceGitOrigins(['ssh://github.com'])
    const cloneUrl = resolveAuthorizedGitSkillCloneUrl('git@github.com:acme/skills.git')
    expect(cloneUrl).toBe('git@github.com:acme/skills.git')

    const env = buildSkillGitAcquisitionEnv({
      agentId: 'agent-1',
      cloneUrl,
      privateHome: '/private/home',
      useGitCredential: true
    })
    expect(env.AC_GITCRED_AGENT).toBeUndefined()
    expect(env.AC_GITCRED_CAPABILITY).toBeUndefined()
  })

  it('never forwards the GitHub credential capability to an allowed non-GitHub SSH origin', () => {
    configureWorkspaceGitOrigins(['ssh://git.example.test:2222'])
    const cloneUrl = resolveAuthorizedGitSkillCloneUrl('ssh://git@git.example.test:2222/acme/skills.git')
    const env = buildSkillGitAcquisitionEnv({
      agentId: 'agent-1',
      cloneUrl,
      privateHome: '/private/home',
      useGitCredential: true
    })

    expect(cloneUrl).toBe('ssh://git@git.example.test:2222/acme/skills.git')
    expect(env.AC_GITCRED_AGENT).toBeUndefined()
    expect(env.AC_GITCRED_CAPABILITY).toBeUndefined()
  })

  it('scopes the daemon credential capability to canonical GitHub HTTPS only', () => {
    initGitInjection({
      targetFor: () => daemonGitCredentialTarget({ shimPath: '/daemon/git-credential-helper', runDir: '/private/run' }),
      preWarm: async () => {},
      capabilityFor: (agentId) => `cap-${agentId}`
    })
    const cloneUrl = resolveAuthorizedGitSkillCloneUrl('git@github.com:acme/skills.git')
    const env = buildSkillGitAcquisitionEnv({
      agentId: 'agent-1',
      cloneUrl,
      privateHome: '/private/home',
      useGitCredential: true
    })
    const config = gitConfig(env)

    expect(cloneUrl).toBe('https://github.com/acme/skills.git')
    expect(env.AC_GITCRED_AGENT).toBe('agent-1')
    expect(env.AC_GITCRED_CAPABILITY).toBe('cap-agent-1')
    expect(config.get('credential.https://github.com.helper')).toBe("!'/daemon/git-credential-helper' agent-1")
    expect(config.get('credential.https://github.com.useHttpPath')).toBe('true')
  })
})
