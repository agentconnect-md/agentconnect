import { describe, expect, it } from 'vitest'
import { codexPermissionProfileConfig } from '../src/acp/codex-permission-profiles.js'

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

  // §11: the per-session HOME is a SIBLING of the cwd, so `:workspace` never reaches it and pnpm/corepack cannot write their caches.
  it('opens a confined session HOME for writes and denies its .codex whole', () => {
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
    // `auth.json` under it LINKS to the shared host credential, and the rest is the ACP parent's own state.
    expect(agent).toContain(`"${home}/.codex" = "deny"`)
    expect(agent).not.toContain(`"${home}/.codex" = "read"`)
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

  // The caller's own `.codex` deny and this one name the same path: one entry, still `deny`.
  it('keeps the session .codex denied once when the caller already protects it', () => {
    const home = '/agent/sessions/session-1/home'
    const config = codexPermissionProfileConfig({
      protectedRoots: [`${home}/.codex`],
      sessionHomeRoot: home
    })!

    const agent = config.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-workspace.filesystem=')
    )!
    expect(agent).toBe(
      `permissions.agentconnect-protected-workspace.filesystem={ "${home}" = "write", "${home}/.codex" = "deny" }`
    )
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

  // agent-full-access is deliberately unconfined; the paired deny belongs only where the write was granted.
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
