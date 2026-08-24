/**
 * Provider-aware git credentials, daemon side (gitlab-com-integration.md
 * §13.2/§17.1): the cache keys gitlab grants apart, gates the provider on the
 * CP's gitcred-provider-v2 advertisement, and rejects a stripped or mismatched
 * provider echo; the helper parses full-depth gitlab paths; the injection
 * module pins exactly one managed host per workspace.
 */
import { describe, it, expect } from 'vitest'
import type { GitCredGrant } from '@agentconnect.md/protocol'
import { GitCredentialCache, GitCredUnavailableError } from '../../src/cp/git-credential.js'
import { projectFromPath, repoFromPath } from '../../src/gitcred/helper.js'
import { initGitInjection, managedCredentialHostOf, sessionGitConfig } from '../../src/workspace/git-injection.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

type Payload = { provider?: string; requestedAccess?: string }

function build(opts: { v2?: boolean; respond: (payload: Payload, n: number) => GitCredGrant }) {
  let calls = 0
  let mono = 0
  const seen: Payload[] = []
  const cache = new GitCredentialCache({
    request: async (payload) => {
      calls += 1
      seen.push(payload)
      return opts.respond(payload, calls)
    },
    log: { warn: () => {} },
    monoNow: () => mono,
    providerV2Supported: () => opts.v2 === true
  })
  return { cache, seen, calls: () => calls, advance: (ms: number) => (mono += ms) }
}

const gitlabGrant: GitCredGrant = {
  username: 'agentconnect-p4455667',
  token: 'glpat-1',
  ttlSec: 3600,
  expiresAt: '2026-08-22T01:00:00.000Z',
  repoFullName: 'example-group/example-project',
  access: 'write',
  provider: 'gitlab',
  externalRepoId: '4455667',
  credentialEpoch: '3',
  providerExpiresAt: '2026-11-20T00:00:00.000Z'
}

const githubGrant: GitCredGrant = {
  username: 'x-access-token',
  token: 'ghs_1',
  ttlSec: 3540,
  expiresAt: '2026-08-22T01:00:00.000Z',
  repoFullName: 'acme/infra',
  access: 'write'
}

describe('GitCredentialCache — gitlab provider (§17.1)', () => {
  it('keys gitlab apart from github and forwards provider + requestedAccess', async () => {
    const h = build({ v2: true, respond: (payload) => (payload.provider === 'gitlab' ? gitlabGrant : githubGrant) })
    const gitlab = await h.cache.get(AGENT, 'clone', { provider: 'gitlab', requestedAccess: 'read' })
    expect(gitlab.username).toBe('agentconnect-p4455667')
    const github = await h.cache.get(AGENT, 'clone')
    expect(github.username).toBe('x-access-token')
    expect(h.calls()).toBe(2) // distinct cache keys, no cross-provider reuse
    expect(h.seen[0]).toMatchObject({ provider: 'gitlab', requestedAccess: 'read' })
    expect(h.seen[1]?.provider).toBeUndefined()
  })

  it('refuses to name a provider before the CP advertises gitcred-provider-v2', async () => {
    const h = build({ v2: false, respond: () => gitlabGrant })
    await expect(h.cache.get(AGENT, 'clone', { provider: 'gitlab' })).rejects.toThrow(GitCredUnavailableError)
    expect(h.calls()).toBe(0) // never even asked — the frame would be misread
  })

  it('rejects a stripped provider echo: an old CP answered the wrong workspace grant', async () => {
    const h = build({ v2: true, respond: () => githubGrant })
    await expect(h.cache.get(AGENT, 'clone', { provider: 'gitlab' })).rejects.toThrow(/provider github/)
  })

  it('rejects a wrong-project numeric echo (§17.1) and evicts by the provider-qualified key on erase', async () => {
    const h = build({ v2: true, respond: () => gitlabGrant })
    await expect(h.cache.get(AGENT, 'clone', { provider: 'gitlab', externalRepoId: '999' })).rejects.toThrow(
      /project 4455667 for project 999/
    )

    // Erase must hit the SAME provider-qualified key the get stored under.
    const cached = await h.cache.get(AGENT, 'clone', { provider: 'gitlab', externalRepoId: '4455667' })
    expect(cached.token).toBe('glpat-1')
    h.cache.invalidate(AGENT, 'glpat-1', { provider: 'gitlab' })
    await h.cache.get(AGENT, 'clone', { provider: 'gitlab', externalRepoId: '4455667' })
    expect(h.calls()).toBe(3) // eviction forced a fresh CP ask
  })
})

describe('gitlab note token under an authoritative denial (19.3)', () => {
  it('a LEASE_DENIED refresh evicts the minted PAT: the poster fails now and re-asks next turn', async () => {
    const h = build({
      v2: true,
      respond: (_payload, n) => {
        if (n === 2) throw Object.assign(new Error('runtime_degraded'), { code: 'LEASE_DENIED' })
        return { ...gitlabGrant, token: `glpat-${n}` }
      }
    })
    expect((await h.cache.getGitlabPostToken(AGENT, '4455667', HOOK)).token).toBe('glpat-1')
    h.advance(50 * 60 * 1000) // below the handout threshold → refresh, and the binding refuses

    await expect(h.cache.getGitlabPostToken(AGENT, '4455667', HOOK)).rejects.toThrow(GitCredUnavailableError)
    // The revoked grant is gone rather than served for the rest of its lease.
    expect((await h.cache.getGitlabPostToken(AGENT, '4455667', HOOK)).token).toBe('glpat-3')
    expect(h.calls()).toBe(3)
  })
})

describe('helper path parsing (§13.2)', () => {
  it('preserves full gitlab subgroup depth; github stays owner/repo', () => {
    expect(projectFromPath('group/sub/deeper/project.git')).toBe('group/sub/deeper/project')
    expect(projectFromPath('/group/project')).toBe('group/project')
    expect(projectFromPath('Group/Project.git/info/lfs')).toBe('group/project')
    expect(projectFromPath('just-a-name')).toBeUndefined()
    expect(repoFromPath('owner/repo.git/info/lfs')).toBe('owner/repo')
  })

  it('resolves the same project from the canonical `.git` remote git now dials (useHttpPath)', async () => {
    const { canonicalWorkspaceGitUrl } = await import('../../src/workspace/git-injection.js')
    // useHttpPath=true sends the remote's own path, so the helper routes on the canonical form: suffix and depth survive.
    for (const configured of [
      'https://gitlab.com/example-group/example-project',
      'https://gitlab.com/example-group/example-project.git'
    ]) {
      const path = new URL(canonicalWorkspaceGitUrl(configured)).pathname
      expect(path).toBe('/example-group/example-project.git')
      expect(projectFromPath(path)).toBe('example-group/example-project')
    }
    const subgroup = new URL(canonicalWorkspaceGitUrl('https://gitlab.com/example-group/sub/deeper/proj')).pathname
    expect(projectFromPath(subgroup)).toBe('example-group/sub/deeper/proj')
    expect(projectFromPath(`${subgroup}/info/lfs`)).toBe('example-group/sub/deeper/proj')
  })
})

describe('managed origin convergence trust (round 2)', () => {
  it('a managed root trusts exactly ITS provider host', async () => {
    const { WorkspaceManager } = await import('../../src/workspace/workspace-manager.js')
    const wm = new WorkspaceManager()
    const gitlabRoot = 'https://gitlab.com/example-group/example-project'
    expect(wm.isTrustedManagedOrigin('https://gitlab.com/example-group/example-project.git', gitlabRoot)).toBe(true)
    expect(wm.isTrustedManagedOrigin('git@gitlab.com:example-group/example-project.git', gitlabRoot)).toBe(true)
    expect(wm.isTrustedManagedOrigin('https://github.com/acme/infra.git', gitlabRoot)).toBe(false)
    const githubRoot = 'https://github.com/acme/infra'
    expect(wm.isTrustedManagedOrigin('https://github.com/acme/infra.git', githubRoot)).toBe(true)
    expect(wm.isTrustedManagedOrigin('https://gitlab.com/g/p.git', githubRoot)).toBe(false)
  })
})

describe('injection host selection (§13.2)', () => {
  const target = { kind: 'daemon' as const, helper: '/x/helper', configDir: '/x/cfg' }
  initGitInjection({
    targetFor: () => target,
    preWarm: async () => {},
    capabilityFor: () => 'cap-test'
  })

  it('derives the managed host from the workspace URL, exactly one per workspace', () => {
    expect(managedCredentialHostOf('https://gitlab.com/example-group/example-project')).toBe('gitlab.com')
    expect(managedCredentialHostOf('https://github.com/acme/infra')).toBe('github.com')
    expect(managedCredentialHostOf('https://code.example.test/x/y')).toBeUndefined()
    expect(managedCredentialHostOf(undefined)).toBeUndefined()
  })

  it('pins the session gitconfig to the workspace host only', () => {
    const gitlab = sessionGitConfig(AGENT, undefined, target, 'gitlab.com')
    expect(gitlab.content).toContain('[credential "https://gitlab.com"]')
    expect(gitlab.content).not.toContain('github.com')
    const github = sessionGitConfig(AGENT, undefined, target)
    expect(github.content).toContain('[credential "https://github.com"]')
    expect(github.content).not.toContain('gitlab.com')
  })
})

describe('glab target resolution (§13.3)', () => {
  it('resolves -R/--repo, GITLAB_REPO, then the cwd origin, at full subgroup depth', async () => {
    const { resolveGlabTargetProject } = await import('../../src/cp/glab-target.js')
    const none = () => undefined
    expect(resolveGlabTargetProject(['mr', 'view', '-R', 'group/sub/proj'], {}, none)).toEqual({
      project: 'group/sub/proj'
    })
    expect(resolveGlabTargetProject(['issue', 'list', '--repo=Group/Proj'], {}, none)).toEqual({
      project: 'group/proj'
    })
    expect(resolveGlabTargetProject([], { GITLAB_REPO: 'group/env-proj' }, none)).toEqual({
      project: 'group/env-proj'
    })
    expect(resolveGlabTargetProject([], {}, () => 'https://gitlab.com/example-group/example-project.git')).toEqual({
      project: 'example-group/example-project'
    })
    expect(resolveGlabTargetProject([], {}, () => 'git@gitlab.com:group/sub/proj.git')).toEqual({
      project: 'group/sub/proj'
    })
  })

  it('defers non-gitlab.com hosts to the real glab (exit-2 contract)', async () => {
    const { resolveGlabTargetProject, normalizeProjectArg } = await import('../../src/cp/glab-target.js')
    expect(normalizeProjectArg('https://code.example.test/g/p')).toEqual({ defer: true })
    expect(normalizeProjectArg('git.example.test/g/p')).toEqual({ defer: true })
    expect(normalizeProjectArg('gitlab.com/group/proj')).toEqual({ project: 'group/proj' })
    expect(resolveGlabTargetProject([], { GITLAB_HOST: 'gitlab.example.test' }, () => 'group/p')).toEqual({
      defer: true
    })
    // Unparseable ⇒ the workspace ask (project undefined, no defer).
    expect(resolveGlabTargetProject([], {}, () => undefined)).toEqual({})
  })
})
