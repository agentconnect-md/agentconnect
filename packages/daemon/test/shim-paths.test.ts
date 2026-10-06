import { describe, expect, it } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareBundleStaging } from '../src/shim/bundle-staging.js'
import {
  DEFAULT_SHIM_PATHS,
  SANDBOX_BUNDLE_STAGING_DIR,
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
      glabTokenEntry: '/opt/agentconnect/shim/glab-token.js',
      autoMergeEntry: '/opt/agentconnect/shim/auto-merge.js',
      mcpBridgeEntry: '/opt/agentconnect/shim/mcp-bridge.js',
      ghWrapperDir: '/opt/agentconnect/pathbin',
      runtimeWrapperDir: '/run/agentconnect/pathbin',
      dshPresetDir: '/opt/agentconnect/dsh/agent-presets/standard-no-search',
      gitConfigDir: '/run/agentconnect/git',
      configFilesDir: '/run/agentconnect/config-files',
      skillStagingDir: '/run/agentconnect/skills-staging',
      bundleStagingDir: '/run/agentconnect/bundle-staging',
      tunnels: { gitcred: '/run/agentconnect/gitcred.sock', mcp: '/run/agentconnect/mcp.sock' }
    })
    expect(DEFAULT_SHIM_PATHS).toEqual(shimPaths())
    expect(SANDBOX_TUNNEL_PATHS).toBe(DEFAULT_SHIM_PATHS.tunnels)
    expect(SANDBOX_GIT_CONFIG_DIR).toBe('/run/agentconnect/git')
    expect(SANDBOX_BUNDLE_STAGING_DIR).toBe('/run/agentconnect/bundle-staging')
    expect(SANDBOX_GIT_CREDENTIAL_HELPER).toBe('/opt/agentconnect/bin/git-credential')
  })

  it('moves every derived path with its root', () => {
    const paths = shimPaths('/tmp/rt', '/srv/helpers')
    const flat = (value: object): string[] =>
      Object.values(value).flatMap((entry) => (typeof entry === 'string' ? [entry] : flat(entry as object)))
    const all = flat(paths)
    expect(all).toHaveLength(14)
    expect(all.every((path) => path.startsWith('/tmp/rt/') || path.startsWith('/srv/helpers/'))).toBe(true)
    expect(all.some((path) => path.includes('/run/agentconnect') || path.includes('/opt/agentconnect'))).toBe(false)
    expect(paths.tunnels).toEqual({ gitcred: '/tmp/rt/gitcred.sock', mcp: '/tmp/rt/mcp.sock' })
    expect(paths.gitConfigDir).toBe('/tmp/rt/git')
    expect(paths.configFilesDir).toBe('/tmp/rt/config-files')
    expect(paths.skillStagingDir).toBe('/tmp/rt/skills-staging')
    expect(paths.bundleStagingDir).toBe('/tmp/rt/bundle-staging')
    expect(paths.mcpBridgeEntry).toBe('/srv/helpers/shim/mcp-bridge.js')
    expect(paths.glabTokenEntry).toBe('/srv/helpers/shim/glab-token.js')
    expect(paths.runtimeWrapperDir).toBe('/tmp/rt/pathbin')
  })

  it('moves only the runtime half when just that root is named', () => {
    const paths = shimPaths('/tmp/rt')
    expect(paths.tunnels.gitcred).toBe('/tmp/rt/gitcred.sock')
    expect(paths.gitCredentialHelper).toBe(DEFAULT_SHIM_PATHS.gitCredentialHelper)
  })
})

describe.skipIf(process.platform === 'win32')('prepareBundleStaging', () => {
  const withRoot = (body: (root: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), 'ac-bundle-staging-'))
    try {
      body(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('creates the directory private to the shim user', () => {
    withRoot((root) => {
      const dir = join(root, 'rt', 'bundle-staging')
      prepareBundleStaging(dir)
      expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    })
  })

  it('tightens an existing directory that others can read', () => {
    withRoot((root) => {
      const dir = join(root, 'bundle-staging')
      mkdirSync(dir, { mode: 0o755 })
      prepareBundleStaging(dir)
      expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    })
  })

  it('drops every leftover entry, since staged handles never survive a shim restart', () => {
    withRoot((root) => {
      const dir = join(root, 'bundle-staging')
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'stale.bundle'), 'x')
      writeFileSync(join(dir, 'stale.bundle.lock'), 'x')
      prepareBundleStaging(dir)
      expect(readdirSync(dir)).toEqual([])
    })
  })

  it('refuses a symlink in place of the directory', () => {
    withRoot((root) => {
      mkdirSync(join(root, 'elsewhere'))
      symlinkSync(join(root, 'elsewhere'), join(root, 'bundle-staging'))
      expect(() => prepareBundleStaging(join(root, 'bundle-staging'))).toThrow(/not a real directory/)
    })
  })
})
