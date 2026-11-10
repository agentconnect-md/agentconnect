import { AGENT_CHANNEL_SOCKET_ENV } from '../agent-channel/env.js'
import type { ShimRequester } from '../shim/channels.js'
import { ShimGitRunner, type GitExecPayload } from '../shim/git-exec.js'
import { GitTransportError, type GitRunner } from '../workspace/git-runner.js'

// A caller's replacement env names this host's HOME and PATH; the environment's own come from its launch.
const environmentOwned = (name: string) =>
  name === 'HOME' || name === 'PATH' || name.startsWith('XDG_') || name === AGENT_CHANNEL_SOCKET_ENV

/** Git in a local environment over its shim's exec channel, as on the pool; only a request the shim received can have run Git. */
export function localShimGitRunner(options: {
  /** One request over the environment's bound shim, the environment held for it: the local executor's `withEnvironment`. */
  run: <T>(work: (session: ShimRequester) => Promise<T>) => Promise<T>
  cwd: string
  /** Beneath a request that sends no env of its own; absent ⇒ the shim's own. */
  env?: Record<string, string>
  /** What the environment names over a caller's replacement env; absent ⇒ the HOME, PATH, XDG dirs and helper socket of `env`. */
  owned?: Record<string, string>
  /** Rewrites a caller's replacement env before `owned` applies, such as the credential helpers of a host reached through the credential proxy. */
  mapEnv?: (env: Record<string, string>) => Record<string, string>
  abort?: AbortSignal
}): GitRunner {
  const owned =
    options.owned ?? Object.fromEntries(Object.entries(options.env ?? {}).filter(([name]) => environmentOwned(name)))
  const mapEnv = options.mapEnv ?? ((env: Record<string, string>) => env)
  return new ShimGitRunner(
    {
      request: async (capability, payload, requestOptions) => {
        let reached = false
        try {
          return await options.run((session) => {
            const { env } = payload as GitExecPayload
            const mapped =
              env === undefined ? payload : { ...(payload as GitExecPayload), env: { ...mapEnv(env), ...owned } }
            reached = true
            return session.request(capability, mapped, requestOptions)
          })
        } catch (error) {
          if (reached) throw error
          throw new GitTransportError(error instanceof Error ? error.message : String(error), error)
        }
      }
    },
    options.cwd,
    options.env,
    options.abort
  )
}
