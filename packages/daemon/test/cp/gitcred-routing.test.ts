/**
 * Per-repo credential ROUTING (multi-repo authorization, #457): the helper's
 * path → repo parsing, the gh wrapper's repo-argument normalization, and the
 * gitcred.sock server's key routing (plane split + workspace folding).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { effectiveAgentId, repoFromPath } from '../../src/cli/git-credential.js'
import { normalizeRepoArg } from '../../src/cp/gh-target.js'
import {
  GITCRED_AGENT_ENV,
  GitCredServer,
  gitcredSocketPath,
  type GitCredServerDeps
} from '../../src/cp/gitcred-server.js'
import type { GitCredentialCache } from '../../src/cp/git-credential.js'

describe('repoFromPath (git credential path → owner/repo)', () => {
  it('parses plain, leading-slash, .git and LFS-subpath forms', () => {
    expect(repoFromPath('acme/infra')).toBe('acme/infra')
    expect(repoFromPath('/acme/infra')).toBe('acme/infra')
    expect(repoFromPath('acme/infra.git')).toBe('acme/infra')
    expect(repoFromPath('acme/infra.git/info/lfs')).toBe('acme/infra')
    expect(repoFromPath('Acme/Infra')).toBe('acme/infra') // lowercased for the cache key
  })

  it('returns undefined for unparseable paths (workspace fallback)', () => {
    expect(repoFromPath('acme')).toBeUndefined()
    expect(repoFromPath('')).toBeUndefined()
    expect(repoFromPath('/')).toBeUndefined()
  })
})

describe('effectiveAgentId (helper identity resolution)', () => {
  afterEach(() => {
    delete process.env[GITCRED_AGENT_ENV]
  })

  it('prefers the env identity minted with the capability over the config-embedded argv id', () => {
    // A `.git/config` helper line outlives the agent that wrote it — a recreated
    // agent adopting the checkout must present ITS id, not the dead one on disk.
    process.env[GITCRED_AGENT_ENV] = 'live-agent'
    expect(effectiveAgentId('stale-agent')).toBe('live-agent')
  })

  it('falls back to the argv id when the env pair is absent or empty', () => {
    expect(effectiveAgentId('argv-agent')).toBe('argv-agent')
    process.env[GITCRED_AGENT_ENV] = ''
    expect(effectiveAgentId('argv-agent')).toBe('argv-agent')
  })
})

describe('normalizeRepoArg (gh wrapper repo argument)', () => {
  it('accepts OWNER/REPO, HOST/OWNER/REPO and github URLs', () => {
    expect(normalizeRepoArg('acme/infra')).toEqual({ repo: 'acme/infra' })
    expect(normalizeRepoArg('acme/infra.git')).toEqual({ repo: 'acme/infra' })
    expect(normalizeRepoArg('github.com/acme/infra')).toEqual({ repo: 'acme/infra' })
    expect(normalizeRepoArg('https://github.com/acme/infra.git')).toEqual({ repo: 'acme/infra' })
    expect(normalizeRepoArg('git@github.com:acme/infra.git')).toEqual({ repo: 'acme/infra' })
  })

  it('defers on non-github hosts (the wrapper runs the real gh untouched)', () => {
    expect(normalizeRepoArg('gitlab.com/acme/infra')).toEqual({ defer: true })
    expect(normalizeRepoArg('https://gitlab.com/acme/infra')).toEqual({ defer: true })
  })

  it('falls back to the workspace token on absent/unparseable input', () => {
    expect(normalizeRepoArg(undefined)).toEqual({})
    expect(normalizeRepoArg('')).toEqual({})
    expect(normalizeRepoArg('not a repo')).toEqual({})
  })
})

describe('GitCredServer routing (gitcred.sock)', () => {
  interface GetOpts {
    plane?: string
    repo?: string
    provider?: string
    externalRepoId?: string
    requestedAccess?: string
  }
  interface GetCall {
    agentId: string
    opts?: GetOpts
  }
  interface EraseCall {
    agentId: string
    password?: string
    opts?: { plane?: string; repo?: string }
  }

  let dir: string | undefined
  let server: GitCredServer | undefined
  afterEach(() => {
    server?.stop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function boot(workspace?: string, spec?: Partial<GitCredServerDeps>) {
    dir = mkdtempSync(join(tmpdir(), 'gitcred-routing-'))
    const sockPath = gitcredSocketPath(dir)
    const gets: GetCall[] = []
    const erases: EraseCall[] = []
    const logs: string[] = []
    const warnings: string[] = []
    const fakeCache = {
      get: async (agentId: string, _reason: string, opts?: GetOpts) => {
        gets.push({ agentId, ...(opts ? { opts } : {}) })
        return {
          username: 'x-access-token',
          token: 'ghs_test',
          repoFullName: opts?.repo ?? 'acme/infra',
          access: 'write' as const,
          expiresAtMono: 0
        }
      },
      invalidate: (agentId: string, password?: string, opts?: GetOpts) => {
        erases.push({ agentId, ...(password !== undefined ? { password } : {}), ...(opts ? { opts } : {}) })
      }
    }
    server = new GitCredServer(fakeCache as unknown as GitCredentialCache, sockPath, {
      log: { info: (message) => logs.push(message), warn: (message) => warnings.push(message) },
      ...(workspace ? { workspaceRepoOf: () => workspace } : {}),
      ...spec
    })
    const capability = server.capabilityFor('a1')
    await server.start()
    return { sockPath, gets, erases, logs, warnings, capability }
  }

  function roundtrip(sockPath: string, msg: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(sockPath)
      let buf = ''
      sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'))
      sock.on('data', (c) => {
        buf += c.toString('utf8')
        const nl = buf.indexOf('\n')
        if (nl === -1) return
        sock.destroy()
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>)
      })
      sock.on('error', reject)
    })
  }

  it('routes get by (plane, repo) and echoes the served repo', async () => {
    const { sockPath, gets, logs, capability } = await boot()
    const res = await roundtrip(sockPath, {
      op: 'get',
      agentId: 'a1',
      capability,
      repoFullName: 'other/tools',
      plane: 'gh'
    })
    expect(res.ok).toBe(true)
    expect(res.repoFullName).toBe('other/tools')
    expect(gets).toEqual([{ agentId: 'a1', opts: { plane: 'gh', repo: 'other/tools' } }])
    expect(logs.join('\n')).toContain('outcome=served')
    expect(logs.join('\n')).not.toContain('ghs_test')
  })

  it('names the numeric project id for an authorized additional gitlab project (§8.3)', async () => {
    // Without the id the ask travels as a display path only, the control plane
    // answers with the WORKSPACE grant, and the echo check rejects it — which is
    // what leaves an exact checkout of an authorized project credential-less.
    const { sockPath, gets, capability } = await boot('example-group/example-project', {
      providerOf: () => 'gitlab',
      qualifiedRepoOf: (_agentId: string, repoFullName: string) =>
        repoFullName === 'example-group/example-second'
          ? ({ provider: 'gitlab', externalId: '4455668' } as const)
          : undefined
    })
    const res = await roundtrip(sockPath, {
      op: 'get',
      agentId: 'a1',
      capability,
      repoFullName: 'example-group/example-second',
      provider: 'gitlab'
    })
    expect(res.ok).toBe(true)
    expect(gets).toEqual([
      {
        agentId: 'a1',
        opts: { plane: 'git', repo: 'example-group/example-second', provider: 'gitlab', externalRepoId: '4455668' }
      }
    ])
  })

  it('routes a private GitHub skill source to GitHub even when the workspace credential is gitlab', async () => {
    // Skill acquisition sends no host hint, so without the spec's skill authority it would reach the gitlab broker.
    const { sockPath, gets, capability } = await boot('example-group/example-project', {
      providerOf: () => 'gitlab',
      qualifiedRepoOf: () => undefined,
      privateGithubSkillRepoOf: (_agentId: string, repoFullName: string) =>
        repoFullName.toLowerCase() === 'example-org/example-skills'
    })
    const res = await roundtrip(sockPath, {
      op: 'get',
      agentId: 'a1',
      capability,
      repoFullName: 'Example-Org/Example-Skills'
    })
    expect(res.ok).toBe(true)
    expect(gets).toEqual([{ agentId: 'a1', opts: { plane: 'git', repo: 'Example-Org/Example-Skills' } }])

    // An unrelated repository still follows the workspace provider.
    const other = await roundtrip(sockPath, {
      op: 'get',
      agentId: 'a1',
      capability,
      repoFullName: 'example-group/other'
    })
    expect(other.ok).toBe(true)
    expect(gets[1]).toEqual({ agentId: 'a1', opts: { plane: 'git', repo: 'example-group/other', provider: 'gitlab' } })
  })

  it.each(['gitlab', 'gitea'] as const)(
    'routes a GitHub additional repository to GitHub when the workspace credential is %s',
    async (workspaceProvider) => {
      // The GitHub helper sends no host hint, so without the spec's GitHub row the ask took the workspace provider.
      const { sockPath, gets, erases, capability } = await boot('example-group/example-project', {
        providerOf: () => workspaceProvider,
        qualifiedRepoOf: () => undefined,
        githubAdditionalRepoOf: (_agentId: string, repoFullName: string) => repoFullName.toLowerCase() === 'acme/infra'
      })
      const git = await roundtrip(sockPath, { op: 'get', agentId: 'a1', capability, repoFullName: 'Acme/Infra' })
      const gh = await roundtrip(sockPath, {
        op: 'get',
        agentId: 'a1',
        capability,
        repoFullName: 'acme/infra',
        plane: 'gh'
      })
      expect([git.ok, gh.ok]).toEqual([true, true])
      expect(gets).toEqual([
        { agentId: 'a1', opts: { plane: 'git', repo: 'Acme/Infra' } },
        { agentId: 'a1', opts: { plane: 'gh', repo: 'acme/infra' } }
      ])

      // The workspace host's own helper naming the same path asks for that host's repository.
      await roundtrip(sockPath, {
        op: 'get',
        agentId: 'a1',
        capability,
        repoFullName: 'acme/infra',
        provider: workspaceProvider
      })
      expect(gets[2]).toEqual({
        agentId: 'a1',
        opts: { plane: 'git', repo: 'acme/infra', provider: workspaceProvider }
      })

      // Erase from the GitHub helper reaches the key its get used.
      await roundtrip(sockPath, { op: 'erase', agentId: 'a1', capability, repoFullName: 'acme/infra', password: 'x' })
      expect(erases).toEqual([{ agentId: 'a1', password: 'x', opts: { plane: 'git', repo: 'acme/infra' } }])
    }
  )

  it('does not fold a private GitHub skill source onto a gitlab workspace that shares its path', async () => {
    // A gitlab workspace `acme/tools` and a private GitHub source `acme/tools` (a mirror) are two
    // repositories on two hosts. Folding by path alone would classify the GitHub acquisition ask as
    // the workspace ask and return the gitlab credential to the GitHub helper.
    const { sockPath, gets, erases, capability } = await boot('acme/tools', {
      providerOf: () => 'gitlab',
      workspaceRepoIdOf: () => '4455668',
      privateGithubSkillRepoOf: (_agentId: string, repoFullName: string) => repoFullName.toLowerCase() === 'acme/tools'
    })
    const res = await roundtrip(sockPath, { op: 'get', agentId: 'a1', capability, repoFullName: 'acme/tools' })
    expect(res.ok).toBe(true)
    expect(gets).toEqual([{ agentId: 'a1', opts: { plane: 'git', repo: 'acme/tools' } }])

    // The gitlab helper's own ask for the workspace still folds onto the repo-less workspace key.
    const ws = await roundtrip(sockPath, {
      op: 'get',
      agentId: 'a1',
      capability,
      repoFullName: 'acme/tools',
      provider: 'gitlab'
    })
    expect(ws.ok).toBe(true)
    expect(gets[1]).toEqual({ agentId: 'a1', opts: { plane: 'git', provider: 'gitlab', externalRepoId: '4455668' } })

    // Erase from the GitHub helper reaches the key the GitHub get used, not the workspace's.
    await roundtrip(sockPath, { op: 'erase', agentId: 'a1', capability, repoFullName: 'acme/tools', password: 'x' })
    expect(erases).toEqual([{ agentId: 'a1', password: 'x', opts: { plane: 'git', repo: 'acme/tools' } }])
  })

  it('does not let a skill repository answer an explicit gitlab host hint', async () => {
    const { sockPath, gets, capability } = await boot(undefined, {
      providerOf: () => 'gitlab',
      privateGithubSkillRepoOf: () => true
    })
    const res = await roundtrip(sockPath, {
      op: 'get',
      agentId: 'a1',
      capability,
      repoFullName: 'example-org/example-skills',
      provider: 'gitlab'
    })
    expect(res.ok).toBe(true)
    expect(gets).toEqual([
      { agentId: 'a1', opts: { plane: 'git', repo: 'example-org/example-skills', provider: 'gitlab' } }
    ])
  })

  it('denies a gitlab project the replicated spec does not authorize', async () => {
    const { sockPath, gets, capability } = await boot(undefined, {
      providerOf: () => 'github',
      qualifiedRepoOf: () => undefined
    })
    const res = await roundtrip(sockPath, {
      op: 'get',
      agentId: 'a1',
      capability,
      repoFullName: 'example-group/unauthorized',
      provider: 'gitlab'
    })
    expect(res.ok).toBe(false)
    expect(gets).toEqual([]) // refused locally; the control plane is never asked
  })

  it('folds a request naming the workspace repo onto the repo-less key', async () => {
    const { sockPath, gets, capability } = await boot('acme/infra')
    const res = await roundtrip(sockPath, {
      op: 'get',
      agentId: 'a1',
      capability,
      repoFullName: 'Acme/Infra'
    })
    expect(res.ok).toBe(true)
    expect(gets).toEqual([{ agentId: 'a1', opts: { plane: 'git' } }]) // no repo → workspace key
  })

  it('erases the provider-qualified key a named gitlab project was served under', async () => {
    // A scratch or github-workspace agent holding a gitlab additional project has a
    // cache entry keyed gitlab, while its WORKSPACE says github. Deriving erase from
    // the workspace alone would invalidate the github key and leave the rejected
    // GitLab token live until its TTL.
    const { sockPath, erases, capability } = await boot(undefined, {
      providerOf: () => 'github',
      qualifiedRepoOf: (_agentId: string, repoFullName: string) =>
        repoFullName === 'example-group/example-second'
          ? ({ provider: 'gitlab', externalId: '4455668' } as const)
          : undefined
    })
    const res = await roundtrip(sockPath, {
      op: 'erase',
      agentId: 'a1',
      capability,
      password: 'glpat_dead',
      repoFullName: 'example-group/example-second',
      provider: 'gitlab'
    })
    expect(res.ok).toBe(true)
    expect(erases).toEqual([
      {
        agentId: 'a1',
        password: 'glpat_dead',
        opts: { plane: 'git', repo: 'example-group/example-second', provider: 'gitlab' }
      }
    ])
  })

  it('routes erase to the same key the get used', async () => {
    const { sockPath, erases, capability } = await boot()
    const res = await roundtrip(sockPath, {
      op: 'erase',
      agentId: 'a1',
      capability,
      password: 'ghs_dead',
      repoFullName: 'other/tools'
    })
    expect(res.ok).toBe(true)
    expect(erases).toEqual([{ agentId: 'a1', password: 'ghs_dead', opts: { plane: 'git', repo: 'other/tools' } }])
  })

  it('rejects missing, cross-agent, and revoked capabilities before cache access', async () => {
    const { sockPath, gets, warnings, capability } = await boot()
    await expect(roundtrip(sockPath, { op: 'get', agentId: 'a1' })).resolves.toMatchObject({ ok: false })

    const otherCapability = server!.capabilityFor('a2')
    await expect(roundtrip(sockPath, { op: 'get', agentId: 'a1', capability: otherCapability })).resolves.toMatchObject(
      { ok: false }
    )

    server!.revoke('a1')
    await expect(roundtrip(sockPath, { op: 'get', agentId: 'a1', capability })).resolves.toMatchObject({ ok: false })
    expect(gets).toHaveLength(0)
    expect(warnings).toHaveLength(3)
  })
})
