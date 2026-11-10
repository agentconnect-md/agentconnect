import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { codexPermissionProfileConfig, codexSessionPermissionProfiles } from '../src/acp/codex-permission-profiles.js'

describe('Codex session Git grants', () => {
  it('refreshes primary and secondary worktree grants while preserving every launch profile', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'codex-session-grants-')))
    const git = (...args: string[]) => execFileSync('git', args, { stdio: 'pipe' }).toString().trim()
    try {
      const owners = ['primary', 'secondary'].map((name) => join(base, name))
      for (const owner of owners) {
        git('init', owner)
        git(
          '-C',
          owner,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.test',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-m',
          'Fixture'
        )
      }
      const roots = owners.map((owner) => join(owner, '.git'))
      for (const root of roots) rmSync(join(root, 'hooks'), { recursive: true, force: true })
      const config = codexPermissionProfileConfig({
        protectedRoots: [join(base, 'credentials')],
        writableGitMetadataRoots: roots
      })!
      const serialized = JSON.stringify(config)
      expect(await codexSessionPermissionProfiles(serialized, roots, owners)).toBeUndefined()
      for (const label of ['cold', 'warm']) {
        const directories = owners.map((owner) => `${owner}-${label}`)
        for (const [index, owner] of owners.entries())
          git('-C', owner, 'worktree', 'add', '-b', label, directories[index]!)
        const profiles = (await codexSessionPermissionProfiles(serialized, roots, directories)) as Record<
          string,
          { filesystem: Record<string, string> }
        >
        for (const id of [config.modeProfiles.agent, config.modeProfiles['agent-full-access']]) {
          const fs = profiles[id]!.filesystem
          expect(fs[join(base, 'credentials')]).toBe('deny')
          for (const directory of directories) {
            const admin = resolve(git('-C', directory, 'rev-parse', '--absolute-git-dir'))
            expect(fs[admin]).toBe('write')
            expect(statSync(join(admin, 'hooks')).isDirectory()).toBe(true)
            for (const name of ['hooks', 'config', 'config.worktree']) expect(fs[join(admin, name)]).toBe('read')
          }
          for (const root of roots) {
            expect(fs[join(root, 'config')]).toBe('read')
            expect(statSync(join(root, 'hooks')).isDirectory()).toBe(true)
          }
          if (label === 'warm')
            expect(Object.keys(fs).some((path) => path.endsWith(join('worktrees', 'primary-cold')))).toBe(false)
        }
        expect(Object.values(profiles[config.modeProfiles['read-only']]!.filesystem)).not.toContain('write')
        expect(await codexSessionPermissionProfiles(serialized, [], directories)).toBeUndefined()
        const staleConfig = codexPermissionProfileConfig({
          protectedRoots: [join(base, 'credentials')],
          writableGitMetadataRoots: roots.slice(0, 1)
        })!
        const staleProfiles = (await codexSessionPermissionProfiles(
          JSON.stringify(staleConfig),
          roots.slice(0, 1),
          directories
        )) as Record<string, { filesystem: Record<string, string> }>
        for (const id of [config.modeProfiles.agent, config.modeProfiles['agent-full-access']]) {
          const fs = staleProfiles[id]!.filesystem
          expect(fs[resolve(git('-C', directories[0]!, 'rev-parse', '--absolute-git-dir'))]).toBe('write')
          expect(fs[resolve(git('-C', directories[1]!, 'rev-parse', '--absolute-git-dir'))]).toBeUndefined()
          expect(fs[join(base, 'credentials')]).toBe('deny')
        }
      }
      expect(JSON.stringify(config)).toBe(serialized)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

// Pod coordinates are POSIX by construction — the sandbox pod is always Linux.
describe.skipIf(process.platform === 'win32')('Codex permission profile launch config', () => {
  it('keeps daemon-owned denies in every ACP mode', () => {
    const config = codexPermissionProfileConfig({
      protectedRoots: ['/agent/home/.codex', '/host/.codex/auth.json']
    })!

    expect(config.modeProfiles).toEqual({
      'read-only': 'agentconnect-protected-read-only',
      agent: 'agentconnect-protected-workspace',
      'agent-full-access': 'agentconnect-protected-full-access'
    })
    expect(config.configOverrides.filter((value) => value.includes('filesystem='))).toEqual([
      expect.stringContaining('"/agent/home/.codex" = "deny"'),
      expect.stringContaining('"/agent/home/.codex" = "deny"'),
      expect.stringContaining('"/agent/home/.codex" = "deny"')
    ])
    expect(config.configOverrides).toContain('permissions.agentconnect-protected-full-access.network.enabled=true')
    expect(config.configOverrides).not.toContain('permissions.agentconnect-protected-workspace.network.enabled=true')
    expect(config.configOverrides).not.toContain('permissions.agentconnect-protected-read-only.network.enabled=true')
  })

  it('opens the inner network layer only for a daemon-provided credential channel', () => {
    const config = codexPermissionProfileConfig({
      protectedRoots: ['/agent/home/.codex'],
      allowModelToolUnixSockets: true
    })!

    expect(config.configOverrides).toContain('permissions.agentconnect-protected-workspace.network.enabled=true')
    expect(config.configOverrides).toContain('permissions.agentconnect-protected-read-only.network.enabled=true')
  })

  it('can open the credential channel without adding empty filesystem overrides', () => {
    const config = codexPermissionProfileConfig({ protectedRoots: [], allowModelToolUnixSockets: true })!

    expect(config.configOverrides).toContain('permissions.agentconnect-protected-workspace.network.enabled=true')
    expect(config.configOverrides).toContain('permissions.agentconnect-protected-read-only.network.enabled=true')
    expect(
      config.configOverrides.filter(
        (value) =>
          value.includes('agentconnect-protected-workspace.filesystem=') ||
          value.includes('agentconnect-protected-read-only.filesystem=')
      )
    ).toEqual([])
  })

  it('rejects non-absolute policy roots', () => {
    expect(() => codexPermissionProfileConfig({ protectedRoots: ['relative/auth.json'] })).toThrow('must be absolute')
  })

  it('opens only the agent Git metadata root and can disable unified exec', () => {
    const config = codexPermissionProfileConfig({
      protectedRoots: ['/agent/home/.codex'],
      writableGitMetadataRoots: ['/agent/workspace/.git'],
      disableUnifiedExec: true
    })!

    expect(config.configOverrides).toContain('features.unified_exec=false')
    expect(config.configOverrides).toContain(
      'permissions.agentconnect-protected-workspace.filesystem={ "/agent/workspace/.git" = "write", ' +
        '"/agent/workspace/.git/worktrees/**" = "write", ' +
        '"/agent/workspace/.git/hooks" = "read", "/agent/workspace/.git/config" = "read", ' +
        '"/agent/home/.codex" = "deny" }'
    )
    expect(
      config.configOverrides.find((value) =>
        value.startsWith('permissions.agentconnect-protected-read-only.filesystem=')
      )
    ).not.toContain('/agent/workspace/.git')
  })

  // Verified against the vendored Codex on Linux: `deny` hides hooks/config from READS too, and Git
  // cannot run without its config; `read` keeps a shell from planting a hook while Git keeps working.
  // The worktrees subtree is named because :workspace pins a session's own admin dir read-only.
  it('keeps hooks and config read-only, and opens the worktrees subtree, in every Git metadata root', () => {
    const config = codexPermissionProfileConfig({
      protectedRoots: [],
      writableGitMetadataRoots: ['/agent/workspace/.git', '/agent/repos/acme/infra/checkout/.git']
    })!

    const agent = config.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-workspace.filesystem=')
    )!
    for (const root of ['/agent/workspace/.git', '/agent/repos/acme/infra/checkout/.git']) {
      expect(agent).toContain(`"${root}" = "write"`)
      expect(agent).toContain(`"${root}/worktrees/**" = "write"`)
      expect(agent).toContain(`"${root}/hooks" = "read"`)
      expect(agent).toContain(`"${root}/config" = "read"`)
      expect(agent).not.toContain(`"${root}/hooks" = "deny"`)
    }
  })

  // A session clone's `.git` is the exact path :workspace pins (§11): its entry alone reopens it, hooks and config stay `read`, and no worktrees subtree hangs off it.
  it('opens a session clone .git exactly: write, hooks and config read, no worktrees subtree', () => {
    const primary = '/agent/sessions/session-1/workspace/.git'
    const secondary = '/agent/sessions/session-1/repos/acme/infra/.git'
    const config = codexPermissionProfileConfig({
      protectedRoots: ['/agent/home/.codex'],
      sessionGitMetadataRoots: [primary, secondary]
    })!

    expect(config.configOverrides).toContain(
      'permissions.agentconnect-protected-workspace.filesystem={ ' +
        `"${primary}" = "write", "${primary}/hooks" = "read", "${primary}/config" = "read", ` +
        `"${secondary}" = "write", "${secondary}/hooks" = "read", "${secondary}/config" = "read", ` +
        '"/agent/home/.codex" = "deny" }'
    )
    const agent = config.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-workspace.filesystem=')
    )!
    expect(agent).not.toContain('worktrees')
    expect(agent).not.toContain('= "deny" }"') // no clone path is denied
    expect(
      config.configOverrides.find((value) =>
        value.startsWith('permissions.agentconnect-protected-read-only.filesystem=')
      )
    ).not.toContain('/agent/sessions')
  })

  it('opens an operator-declared shared store for writes in the agent and full-access profiles, never in read-only', () => {
    const store = '/host/.local/share/pnpm/store'
    const config = codexPermissionProfileConfig({ protectedRoots: ['/host/.codex'], sharedWriteRoots: [store] })!

    const agent = config.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-workspace.filesystem=')
    )!
    expect(agent).toContain(`"${store}" = "write"`)
    expect(agent).toContain('"/host/.codex" = "deny"')
    expect(
      config.configOverrides.find((value) =>
        value.startsWith('permissions.agentconnect-protected-full-access.filesystem=')
      )
    ).toContain(`"${store}" = "write"`)
    expect(
      config.configOverrides.find((value) =>
        value.startsWith('permissions.agentconnect-protected-read-only.filesystem=')
      )
    ).not.toContain(store)
    // The store alone is a policy: nothing else needs to be protected for it to be emitted.
    expect(codexPermissionProfileConfig({ protectedRoots: [], sharedWriteRoots: [store] })).toBeDefined()
  })

  // §11: the per-session HOME is a SIBLING of the cwd, so `:workspace` never reaches it and pnpm/corepack cannot write their caches.
  it('opens a confined session HOME for writes and keeps its .codex read-only', () => {
    const home = '/agent/sessions/session-1/home'
    const config = codexPermissionProfileConfig({
      protectedRoots: [],
      sessionGitMetadataRoots: ['/agent/sessions/session-1/workspace/.git'],
      sessionHomeRoot: home
    })!

    const agent = config.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-workspace.filesystem=')
    )!
    expect(agent).toContain(`"${home}" = "write"`)
    // The ACP parent's state: never writable to the model's tools, but readable, since Codex execs its
    // linux-sandbox helper from `.codex/tmp/arg0` through its own bwrap, which masks a denied directory.
    expect(agent).toContain(`"${home}/.codex" = "read"`)
    expect(agent).not.toContain(`"${home}/.codex" = "deny"`)
    expect(agent).not.toContain('tmp/arg0')
    // The read-only profile grants nothing, and the write never leaks into it.
    expect(
      config.configOverrides.find((value) =>
        value.startsWith('permissions.agentconnect-protected-read-only.filesystem=')
      )
    ).toBeUndefined()
  })

  // The HOME grant is the session tier's alone: nothing appears for a shared-isolation or agent-tier launch.
  it('adds no HOME entry when no confined session HOME is named', () => {
    const config = codexPermissionProfileConfig({
      protectedRoots: ['/agent/home/.codex'],
      writableGitMetadataRoots: ['/agent/workspace/.git']
    })!

    const agent = config.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-workspace.filesystem=')
    )!
    expect(agent).toBe(
      'permissions.agentconnect-protected-workspace.filesystem={ "/agent/workspace/.git" = "write", ' +
        '"/agent/workspace/.git/worktrees/**" = "write", ' +
        '"/agent/workspace/.git/hooks" = "read", "/agent/workspace/.git/config" = "read", ' +
        '"/agent/home/.codex" = "deny" }'
    )
    expect(agent).not.toContain('= "write" }')
  })

  // A caller that cannot list the session `.codex` (an executor's HOME) denies it outright, which wins over the
  // read-only default; Codex's helper below it is then reachable only through a writable carve-out.
  it('keeps the session .codex denied once when the caller protects it outright, and reopens its helper', () => {
    const home = '/agent/sessions/session-1/home'
    const config = codexPermissionProfileConfig({
      protectedRoots: [`${home}/.codex`],
      sessionHomeRoot: home
    })!

    const agent = config.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-workspace.filesystem=')
    )!
    expect(agent).toBe(
      `permissions.agentconnect-protected-workspace.filesystem={ "${home}" = "write", "${home}/.codex" = "deny", "${home}/.codex/tmp/arg0" = "write" }`
    )
    // The read-only profile grants no write, so the carve-out never reaches it.
    expect(
      config.configOverrides.find((value) =>
        value.startsWith('permissions.agentconnect-protected-read-only.filesystem=')
      )
    ).toBe(`permissions.agentconnect-protected-read-only.filesystem={ "${home}/.codex" = "deny" }`)
  })

  // Automatic approval review runs under a read-only derivative of the profile, which keeps no write: only a
  // directory that is not denied leaves Codex its helper there, so the credentials are what is denied.
  it('denies the credentials in a read-only session .codex in every profile, the read-only one included', () => {
    const home = '/agent/sessions/session-1/home'
    const config = codexPermissionProfileConfig({
      protectedRoots: [`${home}/.codex/auth.json`, `${home}/.codex/config.toml`],
      readOnlyRoots: [`${home}/.codex`],
      sessionHomeRoot: home
    })!
    const table = (profile: string) =>
      config.configOverrides.find((value) => value.startsWith(`permissions.${profile}.filesystem=`))!
    expect(table('agentconnect-protected-workspace')).toBe(
      `permissions.agentconnect-protected-workspace.filesystem={ "${home}" = "write", "${home}/.codex" = "read", "${home}/.codex/auth.json" = "deny", "${home}/.codex/config.toml" = "deny" }`
    )
    expect(table('agentconnect-protected-read-only')).toBe(
      `permissions.agentconnect-protected-read-only.filesystem={ "${home}/.codex/auth.json" = "deny", "${home}/.codex/config.toml" = "deny" }`
    )
    expect(table('agentconnect-protected-full-access')).toContain(`"${home}/.codex" = "read"`)
  })

  // Only the session's own Codex home earns the helper carve-out; another protected `.codex` stays denied whole.
  it('reopens no helper subtree under a protected .codex that is not the session HOME', () => {
    const config = codexPermissionProfileConfig({ protectedRoots: ['/host/.codex'] })!
    expect(config.configOverrides.join('\n')).not.toContain('tmp/arg0')
  })

  // A HOME alone is a policy: it must not be silently dropped by the "nothing to say" early return.
  it('emits the profile for a session HOME with no other policy root', () => {
    const config = codexPermissionProfileConfig({
      protectedRoots: [],
      sessionHomeRoot: '/agent/sessions/session-1/home'
    })

    expect(config?.configOverrides).toContain('default_permissions="agentconnect-protected-workspace"')
  })

  it('rejects a non-absolute session HOME', () => {
    expect(() => codexPermissionProfileConfig({ protectedRoots: [], sessionHomeRoot: 'sessions/s1/home' })).toThrow(
      'must be absolute'
    )
  })

  // bwrap's `--bind` is nodev, and the restricted path rebinds a writable `/` over its minimal `/dev`: `/dev/null` would refuse every open.
  it('never pairs a writable root with a deny in the full-access profile', () => {
    const config = codexPermissionProfileConfig({
      protectedRoots: ['/agent/home/.codex'],
      sessionGitMetadataRoots: ['/agent/sessions/s1/workspace/.git'],
      sessionHomeRoot: '/agent/sessions/s1/home'
    })!
    const full = config.configOverrides.filter((value) =>
      value.startsWith('permissions.agentconnect-protected-full-access.')
    )
    expect(full).toContain('permissions.agentconnect-protected-full-access.extends=":workspace"')
    const filesystem = full.find((value) => value.includes('.filesystem='))!
    expect(filesystem).not.toContain(':root')
    expect(filesystem).toContain('"/agent/home/.codex" = "deny"')
    expect(filesystem).toContain('"/agent/sessions/s1/workspace/.git" = "write"')
    expect(filesystem).toContain('"/agent/sessions/s1/home" = "write"')
    expect(full).toContain('permissions.agentconnect-protected-full-access.network.enabled=true')
  })

  // With nothing to deny, a writable root is Codex's full-disk policy, which mounts `/dev` after it.
  it('leaves the full-access profile untouched by the Git metadata grant', () => {
    const config = codexPermissionProfileConfig({
      protectedRoots: [],
      writableGitMetadataRoots: ['/agent/workspace/.git']
    })!

    const fullAccess = config.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-full-access.filesystem=')
    )!
    expect(fullAccess).toContain('"/.git" = "write"')
    expect(fullAccess).not.toContain('deny')
  })
})

// Runs on Windows too: Codex accepts a write subtree only as a literal `/**` suffix, whatever the host's separator.
describe('Codex permission profile on the host platform', () => {
  it('ends the worktrees write subtree with a literal /**', () => {
    const root = resolve('/agent/workspace/.git')
    const config = codexPermissionProfileConfig({ protectedRoots: [], writableGitMetadataRoots: [root] })!

    const agent = config.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-workspace.filesystem=')
    )!
    expect(agent).toContain(`${JSON.stringify(`${join(root, 'worktrees')}/**`)} = "write"`)
    expect(agent).not.toContain('\\\\**')
  })
})
