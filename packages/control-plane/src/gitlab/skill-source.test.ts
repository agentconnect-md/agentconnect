/** GitLab skill-source admission and preview (source-cache.md §11, CP3.2) over a faked GitLab edge. */
import { describe, expect, it } from 'vitest'
import { FakeGitlab } from '../../test/fakes/gitlab-api.js'
import type { GitlabProjectBindingRecord } from '../persistence/ports.js'
import { GitlabApiClient } from './api.js'
import { GitlabOauthDenied } from './oauth.service.js'
import { resolveGitlabSkillProject, scanGitlabSkillProject, type GitlabSkillSourceDeps } from './skill-source.js'

const ORG = 'org-1'
const PRIVATE_ID = 4455667n

function binding(over: Partial<GitlabProjectBindingRecord> = {}): GitlabProjectBindingRecord {
  return {
    id: 'binding-1',
    orgId: ORG,
    projectId: PRIVATE_ID,
    projectPath: 'example-group/example-project',
    defaultBranch: 'trunk',
    installerConnectionId: 'conn-1',
    webhookId: null,
    desiredEventsHash: null,
    credentialEpoch: 1n,
    convergeOwedAt: null,
    state: 'ready',
    stateReason: null,
    createdAt: new Date(0),
    ...over
  }
}

function harness(opts: { bound?: GitlabProjectBindingRecord | null; token?: string | Error; baseUrl?: string } = {}) {
  const fake = new FakeGitlab({
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    publicPaths: { 'example-group/public-kit': 77 },
    repositories: {
      'example-group/public-kit': {
        files: ['README.md', 'skills/review/SKILL.md', 'skills/deploy/SKILL.md'],
        tags: ['v1']
      },
      [String(PRIVATE_ID)]: {
        files: ['packs/core/skills/lint/SKILL.md', 'packs/other/skills/x/SKILL.md'],
        branches: ['main', 'trunk']
      }
    }
  })
  const bound = opts.bound === undefined ? binding() : opts.bound
  const deps: GitlabSkillSourceDeps = {
    api: fake.api,
    oauth: {
      withAccessToken: async () => {
        if (opts.token instanceof Error) throw opts.token
        return opts.token ?? 'at-1'
      }
    },
    bindings: {
      byProjectPath: async (_org, path) =>
        bound && bound.projectPath.toLowerCase() === path.toLowerCase() ? bound : null,
      byProject: async (_org, id) => (bound && bound.projectId === id ? bound : null)
    }
  }
  return { fake, deps }
}

describe('resolveGitlabSkillProject', () => {
  it('ignores a source on any other host', async () => {
    const { deps } = harness()
    expect(await resolveGitlabSkillProject(deps, ORG, 'https://git.example.test/team/skills')).toBeNull()
    expect(await resolveGitlabSkillProject(deps, ORG, 'example-org/example-kit')).toBeNull()
  })

  it('admits a public project anonymously under its canonical address', async () => {
    const { deps, fake } = harness()
    expect(await resolveGitlabSkillProject(deps, ORG, 'https://gitlab.com/example-group/public-kit.git')).toEqual({
      status: 'ok',
      projectPath: 'example-group/public-kit',
      source: 'https://gitlab.com/example-group/public-kit',
      defaultBranch: 'main',
      credential: null
    })
    // The public probe never presents a bearer.
    expect(fake.requests.every((r) => r.token === null)).toBe(true)
  })

  it('credentials a private managed project by its numeric id, re-read through the installer connection', async () => {
    const { deps, fake } = harness()
    expect(await resolveGitlabSkillProject(deps, ORG, 'https://gitlab.com/example-group/example-project')).toEqual({
      status: 'ok',
      projectPath: 'example-group/example-project',
      source: 'https://gitlab.com/example-group/example-project',
      defaultBranch: 'main',
      credential: { projectId: PRIVATE_ID, cloneUrl: 'https://gitlab.com/example-group/example-project.git' }
    })
    expect(fake.requests.some((r) => r.url.endsWith(`/projects/${PRIVATE_ID}`) && r.token === 'at-1')).toBe(true)
  })

  it('falls back to the binding facts when no connection can answer', async () => {
    const { deps } = harness({ token: new GitlabOauthDenied('gone', 409) })
    expect(await resolveGitlabSkillProject(deps, ORG, 'https://gitlab.com/example-group/example-project')).toEqual({
      status: 'ok',
      projectPath: 'example-group/example-project',
      source: 'https://gitlab.com/example-group/example-project',
      defaultBranch: 'trunk',
      credential: { projectId: PRIVATE_ID }
    })
  })

  it('refuses a private project without a live binding, and a GitLab route path', async () => {
    expect(
      await resolveGitlabSkillProject(
        harness({ bound: null }).deps,
        ORG,
        'https://gitlab.com/example-group/example-project'
      )
    ).toEqual({ status: 'needs-binding' })
    expect(
      await resolveGitlabSkillProject(
        harness({ bound: binding({ state: 'cleanup_pending' }) }).deps,
        ORG,
        'https://gitlab.com/example-group/example-project'
      )
    ).toEqual({ status: 'needs-binding' })
    expect(
      await resolveGitlabSkillProject(harness().deps, ORG, 'https://gitlab.com/example-group/public-kit/-/tree/main/x')
    ).toEqual({ status: 'subpath' })
  })

  it('reports an unreachable instance as retryable, not as a verdict', async () => {
    const { deps } = harness()
    deps.api = new GitlabApiClient('https://gitlab.com', async () => {
      throw new Error('connect ECONNREFUSED')
    })
    expect(await resolveGitlabSkillProject(deps, ORG, 'https://gitlab.com/example-group/public-kit')).toEqual({
      status: 'unreachable'
    })
  })

  it('admits a project on a path-prefixed self-managed instance', async () => {
    const { deps } = harness({ baseUrl: 'https://gitlab.example.test/gl' })
    const project = await resolveGitlabSkillProject(
      deps,
      ORG,
      'https://gitlab.example.test/gl/example-group/public-kit'
    )
    expect(project).toMatchObject({ status: 'ok', source: 'https://gitlab.example.test/gl/example-group/public-kit' })
  })
})

describe('scanGitlabSkillProject', () => {
  it('scans a public project anonymously with GitHub layout precedence', async () => {
    const { deps } = harness()
    expect(await scanGitlabSkillProject(deps, ORG, { projectPath: 'example-group/public-kit' })).toEqual({
      branches: ['main'],
      tags: ['v1'],
      skills: [
        { name: 'review', dirPath: 'skills/review' },
        { name: 'deploy', dirPath: 'skills/deploy' }
      ]
    })
  })

  it('scans a private project through its binding, scoped to the subdirectory', async () => {
    const { deps, fake } = harness()
    const scan = await scanGitlabSkillProject(deps, ORG, { projectId: PRIVATE_ID }, 'trunk', 'packs/core')
    expect(scan).toEqual({ branches: ['main', 'trunk'], tags: [], skills: [{ name: 'lint', dirPath: 'skills/lint' }] })
    expect(fake.requests.some((r) => r.url.includes('/repository/tree?recursive=true&ref=trunk'))).toBe(true)
  })

  it('refuses a private scan no binding vouches for', async () => {
    await expect(
      scanGitlabSkillProject(harness({ bound: null }).deps, ORG, { projectId: PRIVATE_ID })
    ).rejects.toBeInstanceOf(GitlabOauthDenied)
  })
})
