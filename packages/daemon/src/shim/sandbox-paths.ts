/**
 * Paths the RUNTIME IMAGE fixes, as opposed to paths this daemon owns.
 *
 * They live in their own module because the distinction is the whole point: a daemon-derived path
 * means nothing inside a sandbox, and the bugs that come from mixing the two coordinate systems
 * are silent — git asks a credential helper that exists on a machine it is not on, and the failure
 * surfaces as an authentication error. Anything here has a counterpart in
 * `docker/runtime-sandbox.Dockerfile`, and changing one without the other breaks the pod.
 */

/** The credential helper git runs inside the pod. Root-owned and read-only, like the shim. */
export const SANDBOX_GIT_CREDENTIAL_HELPER = '/opt/agentconnect/bin/git-credential'

/** The gh wrapper's token fetch in the pod — the in-sandbox twin of the daemon's hidden `gh-token` subcommand. */
export const SANDBOX_GH_TOKEN_ENTRY = '/opt/agentconnect/shim/gh-token.js'

/** The in-pod merge-when-ready watcher the shim spawns per armed pull request — one process, killed
 *  on disarm and gone with the pod. Its presence is REPORTED by the automerge handler rather than
 *  assumed: an image built before it ships none, and the daemon must read that skew, not guess. */
export const SANDBOX_AUTO_MERGE_ENTRY = '/opt/agentconnect/shim/auto-merge.js'

/** The AgentConnect tool server the agent's harness spawns in the pod, reached over the `mcp` tunnel.
 *  Reported to the daemon by the probe rather than assumed: an image built before it ships none. */
export const SANDBOX_MCP_BRIDGE_ENTRY = '/opt/agentconnect/shim/mcp-bridge.js'

/** The ONLY image directory prepended to the runtime's PATH: the gh and agent-browser wrappers. */
// Its own dir rather than reusing bin/ or shim/: those hold the credential helper and the runtime-table
// generator, and neither should become a command an agent can run by name.
export const SANDBOX_GH_WRAPPER_DIR = '/opt/agentconnect/pathbin'

/** Pod env naming the Chrome the image bakes — agent-browser's only browser-location hook, so an ACP child
 *  without it downloads one of its own. Set by the image, projected onto the child by acp-runner. */
export const SANDBOX_BROWSER_EXECUTABLE_ENV = 'AGENT_BROWSER_EXECUTABLE_PATH'

/** Where daemon-written, per-agent git configuration is materialized in the pod. Under /run rather
 *  than the workspace volume: it is regenerated per launch and belongs to the POD, so a resumed
 *  workspace must not carry a previous incarnation's copy. */
export const SANDBOX_GIT_CONFIG_DIR = '/run/agentconnect/git'

/** Shim-owned scratch space for bounded skill snapshots; callers receive opaque handles only. */
export const SANDBOX_SKILL_STAGING_DIR = '/run/agentconnect/skills-staging'

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

/**
 * The daemon-side servers the shim serves locally, and the in-pod path of each.
 *
 * A plain record here rather than beside the tunnel's schemas, because the credential helper needs
 * the gitcred path and nothing else: importing it from a module that also holds zod schemas made
 * rolldown emit a chunk shared with the channel bundle — a third file the image never copies, and a
 * 136 KB one at that. `tunnel.ts` re-exports this typed against its own enum, so the two cannot
 * name different sets.
 */
export type SandboxTunnelName = 'gitcred' | 'mcp'
export const SANDBOX_TUNNEL_PATHS: Readonly<Record<SandboxTunnelName, string>> = Object.freeze({
  gitcred: '/run/agentconnect/gitcred.sock',
  mcp: '/run/agentconnect/mcp.sock'
})

/** The no-search DeepSeek Harness preset the image bakes (docker/runtime-sandbox/bake-dsh-preset.mjs),
 *  which the shim copies into the pod's `$DSH_HOME/.agent-presets` before launching that runtime. Its
 *  presence is CONSULTED rather than assumed: an image built before it ships none, and such a pod must
 *  keep launching exactly as it always did. */
export const SANDBOX_DSH_PRESET_DIR = '/opt/agentconnect/dsh/agent-presets/standard-no-search'

/** The preset id the directory above supplies — the roster reads it from the directory NAME, so this
 *  is the same string as that path's last segment and the settings default the shim writes. */
export const SANDBOX_DSH_PRESET_ID = 'standard-no-search'
