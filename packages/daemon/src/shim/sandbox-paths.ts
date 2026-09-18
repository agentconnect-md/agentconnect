/**
 * Paths the RUNTIME IMAGE fixes, as opposed to paths this daemon owns.
 *
 * They live in their own module because the distinction is the whole point: a daemon-derived path
 * means nothing inside a sandbox, and the bugs that come from mixing the two coordinate systems
 * are silent — git asks a credential helper that exists on a machine it is not on, and the failure
 * surfaces as an authentication error. Anything here has a counterpart in
 * `docker/runtime-sandbox.Dockerfile`, and changing one without the other breaks the pod.
 */

export type SandboxTunnelName = 'gitcred' | 'mcp'

/** The preset id the DSH preset directory supplies — the roster reads it from the directory NAME. */
export const SANDBOX_DSH_PRESET_ID = 'standard-no-search'

/** Every image- or runtime-rooted location the shim derives; the defaults are the pod image's layout. */
export interface ShimPaths {
  gitCredentialHelper: string
  ghTokenEntry: string
  autoMergeEntry: string
  mcpBridgeEntry: string
  ghWrapperDir: string
  dshPresetDir: string
  gitConfigDir: string
  skillStagingDir: string
  tunnels: Readonly<Record<SandboxTunnelName, string>>
}

export const DEFAULT_SHIM_RUNTIME_ROOT = '/run/agentconnect'
export const DEFAULT_SHIM_HELPER_ROOT = '/opt/agentconnect'

/** Derive every shim path from one runtime root (sockets, Git config, staging) and one helper root (image entries). */
// Plain concatenation with '/': these are paths inside a POSIX sandbox, whatever OS the daemon importing them runs on.
export function shimPaths(runtimeRoot = DEFAULT_SHIM_RUNTIME_ROOT, helperRoot = DEFAULT_SHIM_HELPER_ROOT): ShimPaths {
  return Object.freeze({
    gitCredentialHelper: `${helperRoot}/bin/git-credential`,
    ghTokenEntry: `${helperRoot}/shim/gh-token.js`,
    autoMergeEntry: `${helperRoot}/shim/auto-merge.js`,
    mcpBridgeEntry: `${helperRoot}/shim/mcp-bridge.js`,
    ghWrapperDir: `${helperRoot}/pathbin`,
    dshPresetDir: `${helperRoot}/dsh/agent-presets/${SANDBOX_DSH_PRESET_ID}`,
    gitConfigDir: `${runtimeRoot}/git`,
    skillStagingDir: `${runtimeRoot}/skills-staging`,
    tunnels: Object.freeze({ gitcred: `${runtimeRoot}/gitcred.sock`, mcp: `${runtimeRoot}/mcp.sock` })
  })
}

/** The pod image's layout, which backs every `SANDBOX_*` path constant below. */
export const DEFAULT_SHIM_PATHS = shimPaths()

/** The credential helper git runs inside the pod. Root-owned and read-only, like the shim. */
export const SANDBOX_GIT_CREDENTIAL_HELPER = DEFAULT_SHIM_PATHS.gitCredentialHelper

/** The gh wrapper's token fetch in the pod — the in-sandbox twin of the daemon's hidden `gh-token` subcommand. */
export const SANDBOX_GH_TOKEN_ENTRY = DEFAULT_SHIM_PATHS.ghTokenEntry

/** The in-pod merge-when-ready watcher the shim spawns per armed pull request — one process, killed
 *  on disarm and gone with the pod. Its presence is REPORTED by the automerge handler rather than
 *  assumed: an image built before it ships none, and the daemon must read that skew, not guess. */
export const SANDBOX_AUTO_MERGE_ENTRY = DEFAULT_SHIM_PATHS.autoMergeEntry

/** The AgentConnect tool server the agent's harness spawns in the pod, reached over the `mcp` tunnel.
 *  Reported to the daemon by the probe rather than assumed: an image built before it ships none. */
export const SANDBOX_MCP_BRIDGE_ENTRY = DEFAULT_SHIM_PATHS.mcpBridgeEntry

/** The ONLY image directory prepended to the runtime's PATH: the gh and agent-browser wrappers. */
// Its own dir rather than reusing bin/ or shim/: those hold the credential helper and the runtime-table
// generator, and neither should become a command an agent can run by name.
export const SANDBOX_GH_WRAPPER_DIR = DEFAULT_SHIM_PATHS.ghWrapperDir

/** Pod env naming the Chrome the image bakes — agent-browser's only browser-location hook, so an ACP child
 *  without it downloads one of its own. Set by the image, projected onto the child by acp-runner. */
export const SANDBOX_BROWSER_EXECUTABLE_ENV = 'AGENT_BROWSER_EXECUTABLE_PATH'

/** Where daemon-written, per-agent git configuration is materialized in the pod. Under /run rather
 *  than the workspace volume: it is regenerated per launch and belongs to the POD, so a resumed
 *  workspace must not carry a previous incarnation's copy. */
export const SANDBOX_GIT_CONFIG_DIR = DEFAULT_SHIM_PATHS.gitConfigDir

/** Shim-owned scratch space for bounded skill snapshots; callers receive opaque handles only. */
export const SANDBOX_SKILL_STAGING_DIR = DEFAULT_SHIM_PATHS.skillStagingDir

/**
 * Where a git-repo workspace is checked out, relative to the pod's workspace mount.
 *
 * A subdirectory rather than the mount itself, because the mount is also the runtime's HOME: a
 * checkout at the root would put the repository's working tree on top of `.claude`, `.codex` and
 * `.config`, where `git status` reports them as untracked and `git clean` would delete them. A
 * from-scratch workspace keeps using the root — it has no working tree to confuse with HOME, and
 * moving it would strand every volume already provisioned.
 */
export const SANDBOX_CHECKOUT_DIR = 'repo'

/** The daemon-side servers the shim serves locally; a plain record, because a zod import here adds a chunk the image never copies. */
export const SANDBOX_TUNNEL_PATHS: Readonly<Record<SandboxTunnelName, string>> = DEFAULT_SHIM_PATHS.tunnels

/** The baked no-search DeepSeek Harness preset; CONSULTED rather than assumed, since an older image ships none. */
export const SANDBOX_DSH_PRESET_DIR = DEFAULT_SHIM_PATHS.dshPresetDir
