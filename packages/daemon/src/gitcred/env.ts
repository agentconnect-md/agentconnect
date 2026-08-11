/**
 * The three environment names the credential channel travels on.
 *
 * A leaf on purpose: the same helper source runs as a daemon CLI subcommand and inside a sandbox
 * pod, and the in-sandbox build asserts that its bundle imports nothing but node builtins. Keeping
 * these here — rather than in `cp/gitcred-server.ts`, which pulls the daemon's credential cache —
 * is what lets one implementation serve both.
 */

export const GITCRED_CAPABILITY_ENV = 'AC_GITCRED_CAPABILITY'
/** The agent identity minted TOGETHER with the capability (git-injection
 *  gitCredentialEnv). Helpers prefer this pair over the agentId baked into a
 *  `.git/config` helper line, which goes stale when an agent is deleted and
 *  recreated under the same name over a surviving checkout. */
export const GITCRED_AGENT_ENV = 'AC_GITCRED_AGENT'
/** Where a helper finds the socket, when that is not under this daemon's own root. A helper
 *  running in a sandbox pod reaches the daemon through the shim's tunnel instead, and the pod's
 *  filesystem has no daemon root to derive a path from. Non-secret: it is a path, and the
 *  capability is what authorizes the request that travels over it. */
export const GITCRED_SOCKET_ENV = 'AC_GITCRED_SOCKET'
