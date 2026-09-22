import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHIM_PATHS,
  SANDBOX_GIT_CONFIG_DIR,
  SANDBOX_GIT_CREDENTIAL_HELPER,
  SANDBOX_TUNNEL_PATHS,
  shimPaths
} from '../src/shim/sandbox-paths.js'

describe('shimPaths', () => {
  it('defaults to the literals the runtime image fixes', () => {
    expect(shimPaths()).toEqual({
      gitCredentialHelper: '/opt/agentconnect/bin/git-credential',
      ghTokenEntry: '/opt/agentconnect/shim/gh-token.js',
      autoMergeEntry: '/opt/agentconnect/shim/auto-merge.js',
      mcpBridgeEntry: '/opt/agentconnect/shim/mcp-bridge.js',
      ghWrapperDir: '/opt/agentconnect/pathbin',
      dshPresetDir: '/opt/agentconnect/dsh/agent-presets/standard-no-search',
      gitConfigDir: '/run/agentconnect/git',
      configFilesDir: '/run/agentconnect/config-files',
      skillStagingDir: '/run/agentconnect/skills-staging',
      tunnels: { gitcred: '/run/agentconnect/gitcred.sock', mcp: '/run/agentconnect/mcp.sock' }
    })
    expect(DEFAULT_SHIM_PATHS).toEqual(shimPaths())
    expect(SANDBOX_TUNNEL_PATHS).toBe(DEFAULT_SHIM_PATHS.tunnels)
    expect(SANDBOX_GIT_CONFIG_DIR).toBe('/run/agentconnect/git')
    expect(SANDBOX_GIT_CREDENTIAL_HELPER).toBe('/opt/agentconnect/bin/git-credential')
  })

  it('moves every derived path with its root', () => {
    const paths = shimPaths('/tmp/rt', '/srv/helpers')
    const flat = (value: object): string[] =>
      Object.values(value).flatMap((entry) => (typeof entry === 'string' ? [entry] : flat(entry as object)))
    const all = flat(paths)
    expect(all).toHaveLength(11)
    expect(all.every((path) => path.startsWith('/tmp/rt/') || path.startsWith('/srv/helpers/'))).toBe(true)
    expect(all.some((path) => path.includes('/run/agentconnect') || path.includes('/opt/agentconnect'))).toBe(false)
    expect(paths.tunnels).toEqual({ gitcred: '/tmp/rt/gitcred.sock', mcp: '/tmp/rt/mcp.sock' })
    expect(paths.gitConfigDir).toBe('/tmp/rt/git')
    expect(paths.configFilesDir).toBe('/tmp/rt/config-files')
    expect(paths.skillStagingDir).toBe('/tmp/rt/skills-staging')
    expect(paths.mcpBridgeEntry).toBe('/srv/helpers/shim/mcp-bridge.js')
  })

  it('moves only the runtime half when just that root is named', () => {
    const paths = shimPaths('/tmp/rt')
    expect(paths.tunnels.gitcred).toBe('/tmp/rt/gitcred.sock')
    expect(paths.gitCredentialHelper).toBe(DEFAULT_SHIM_PATHS.gitCredentialHelper)
  })
})
