import { describe, expect, it } from 'vitest'
import { codexPermissionProfileConfig } from '../src/acp/codex-permission-profiles.js'

describe('Codex permission profile launch config', () => {
  it('keeps daemon-owned denies in every ACP mode', () => {
    const config = codexPermissionProfileConfig(['/agent/home/.codex', '/host/.codex/auth.json'])!

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
  })

  it('rejects non-absolute policy roots', () => {
    expect(() => codexPermissionProfileConfig(['relative/auth.json'])).toThrow('must be absolute')
  })
})
