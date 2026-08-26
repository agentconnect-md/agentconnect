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
      'permissions.agentconnect-protected-workspace.filesystem={ "/agent/workspace/.git" = "write", "/agent/home/.codex" = "deny" }'
    )
    expect(
      config.configOverrides.find((value) =>
        value.startsWith('permissions.agentconnect-protected-read-only.filesystem=')
      )
    ).not.toContain('/agent/workspace/.git')
  })
})
