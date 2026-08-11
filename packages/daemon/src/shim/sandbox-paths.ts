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

/** Where daemon-written, per-agent git configuration is materialized in the pod. Under /run rather
 *  than the workspace volume: it is regenerated per launch and belongs to the POD, so a resumed
 *  workspace must not carry a previous incarnation's copy. */
export const SANDBOX_GIT_CONFIG_DIR = '/run/agentconnect/git'

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
