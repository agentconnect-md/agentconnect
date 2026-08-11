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
